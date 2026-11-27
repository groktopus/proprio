import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import {
  buildRunnerEgressSandboxCommand,
  buildRunnerEgressProviderSandboxCommand,
  parseRunnerEgressPolicy,
  RUNNER_EGRESS_PROXY_PORT,
  startRunnerEgressProxy,
} from "./provider-egress.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Runner egress policy", () => {
  it("treats unset policy as disabled and validates exact operator-supplied HTTPS hosts", () => {
    expect(parseRunnerEgressPolicy(undefined)).toBeNull();
    expect(parseRunnerEgressPolicy("[]")).toEqual({ allowlist: [] });
    expect(parseRunnerEgressPolicy('["api.example.test", "https://gateway.example.test:8443", "api.example.test:443", "api.example.test:0443"]'))
      .toEqual({ allowlist: ["api.example.test", "gateway.example.test:8443", "api.example.test:443"] });
    for (const raw of [
      '["*.example.test"]',
      '["127.0.0.1"]',
      '["https://user:pass@example.test"]',
      '["https://example.test/path"]',
      '["example.test:0"]',
      '{"allow":"all"}',
      "x".repeat(16 * 1024 + 1),
    ]) expect(() => parseRunnerEgressPolicy(raw)).toThrow();
  });

  it("wraps the verified guardian with an isolated network namespace and preserves its inherited descriptors", () => {
    const wrapped = buildRunnerEgressSandboxCommand({
      command: "/proc/self/fd/17",
      args: ["--eval", "guard"],
      socketDirectory: "/tmp/prp-egress-proxy",
      workingDirectory: "/workspace/project",
      inheritedDescriptorCount: 12,
      sandboxCommand: "/usr/bin/bwrap",
    });
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.args).toEqual([
      "--die-with-parent", "--unshare-net", "--cap-add", "CAP_NET_ADMIN",
      "--bind", "/", "/", "--tmpfs", "/run", "--dir", "/run/proprio-egress",
      "--bind", "/tmp/prp-egress-proxy", "/run/proprio-egress",
      "--dir", "/proprio-work", "--bind", "/workspace/project", "/proprio-work",
      "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--chdir", "/proprio-work",
      "--preserve-fds", "12", "--", "/bin/sh", "-c", "/usr/sbin/ip link set lo up && exec \"$@\"",
      "proprio-egress", "/proc/self/fd/17", "--eval", "guard",
    ]);
    expect(wrapped.env).toMatchObject({
      HTTP_PROXY: `http://127.0.0.1:${RUNNER_EGRESS_PROXY_PORT}`,
      HTTPS_PROXY: `http://127.0.0.1:${RUNNER_EGRESS_PROXY_PORT}`,
      ALL_PROXY: `http://127.0.0.1:${RUNNER_EGRESS_PROXY_PORT}`,
      NO_PROXY: "",
      no_proxy: "",
      PROPRIO_RUNNER_EGRESS_SOCKET: "/run/proprio-egress/broker.sock",
    });
    expect(buildRunnerEgressProviderSandboxCommand({
      command: "/usr/bin/node",
      args: ["--eval", "provider"],
      seccompDescriptor: 15,
      inheritedDescriptorCount: 13,
    })).toEqual({
      command: "/usr/bin/bwrap",
      args: [
        "--die-with-parent", "--share-net", "--unshare-pid", "--bind", "/", "/",
        "--proc", "/proc", "--tmpfs", "/run/proprio-egress", "--tmpfs", "/tmp",
        "--tmpfs", "/var/tmp", "--cap-drop", "ALL",
        "--seccomp", "15", "--preserve-fds", "13", "--", "/usr/bin/node", "--eval", "provider",
      ],
    });
  });

  it.runIf(process.env.PROPRIO_TEST_EGRESS_PROXY === "1")("pins allowed DNS answers, rejects private and mixed public/private answers, and rechecks redirected destinations", async () => {
    const connectedTargets: Array<{ host: string; family: number; port: number }> = [];
    const proxy = await startRunnerEgressProxy(
      { allowlist: ["provider.example.test", "private.example.test", "mixed.example.test", "malformed.example.test"] },
      {
        lookup: async (hostname) => hostname === "provider.example.test"
          ? [{ address: "93.184.216.34", family: 4 }]
          : hostname === "mixed.example.test"
            ? [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]
            : hostname === "malformed.example.test"
              ? [{ address: "not-an-ip", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }],
        connect: (target) => {
          connectedTargets.push(target);
          const upstream = new Duplex({
            read() {},
            write(_chunk, _encoding, callback) { callback(); },
          }) as net.Socket;
          Object.defineProperty(upstream, "setTimeout", { value: () => upstream });
          process.nextTick(() => upstream.emit("connect"));
          return upstream;
        },
      },
    );
    cleanups.push(async () => {
      await proxy.close();
    });
    const seccompProgram = await readFile(path.join(proxy.socketDirectory, "provider-no-unix-sockets.bpf"));
    expect(seccompProgram.byteLength).toBe(20 * 8);
    const constants = Array.from({ length: 20 }, (_, index) => seccompProgram.readUInt32LE(index * 8 + 4));
    expect(constants).toContain(process.arch === "x64" ? 0xc000_003e : 0xc000_00b7);
    expect(constants).toContain(0x4000_0000); // x32 ABI bit
    expect(constants).toContain(process.arch === "x64" ? 41 : 198); // socket syscall
    expect(constants).toContain(process.arch === "x64" ? 53 : 199); // socketpair syscall
    expect(constants).toContain(425); // io_uring_setup

    const tunneled = await connectThroughProxy(proxy.socketPath, "provider.example.test:443");
    expect(tunneled).toBe(true);
    expect(connectedTargets).toEqual([{ host: "93.184.216.34", family: 4, port: 443 }]);
    expect(await connectThroughProxy(proxy.socketPath, "private.example.test:443")).toBe(false);
    expect(await connectThroughProxy(proxy.socketPath, "mixed.example.test:443")).toBe(false);
    expect(await connectThroughProxy(proxy.socketPath, "malformed.example.test:443")).toBe(false);
    expect(await connectThroughProxy(proxy.socketPath, "other.example.test:443")).toBe(false);
    expect(connectedTargets).toHaveLength(1);
  });

  it.runIf(process.env.PROPRIO_TEST_BWRAP === "/usr/bin/bwrap")(
    "blocks direct host access while allowing only pinned proxy targets in a real Linux network namespace",
    async () => {
      const origin = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
      const originAddress = origin.address();
      if (!originAddress || typeof originAddress === "string") throw new Error("Expected TCP origin fixture.");
      const hostSocketDirectory = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "prp-egress-host-socket-"));
      const hostSocketPath = path.join(hostSocketDirectory, "host-service.sock");
      let hostSocketConnections = 0;
      const hostSocket = net.createServer((socket) => { hostSocketConnections += 1; socket.destroy(); });
      await new Promise<void>((resolve, reject) => {
        hostSocket.once("error", reject);
        hostSocket.listen(hostSocketPath, () => { hostSocket.off("error", reject); resolve(); });
      });
      const proxy = await startRunnerEgressProxy({ allowlist: ["provider.example.test"] }, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        connect: () => net.connect({ host: "127.0.0.1", port: originAddress.port }),
      });
      cleanups.push(async () => {
        await proxy.close();
        await new Promise<void>((resolve) => origin.close(() => resolve()));
        await new Promise<void>((resolve) => hostSocket.close(() => resolve()));
        await rm(hostSocketDirectory, { recursive: true, force: true });
      });

      const providerCode = `
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const proxy = new URL(process.env.HTTPS_PROXY);
function replaceBrokerPath(candidate) {
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.rmSync(candidate, { force: true });
    fs.symlinkSync(process.env.PROPRIO_TEST_HOST_SOCKET, candidate);
    return true;
  } catch { return false; }
}
function connectThrough(authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.hostname);
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write("CONNECT " + authority + " HTTP/1.1\\r\\nHost: " + authority + "\\r\\n\\r\\n"));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(response.slice(0, response.indexOf("\\r\\n"))); }
    });
    socket.setTimeout(3000, () => socket.destroy(new Error("proxy timeout")));
  });
}
function directAddressRequest(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1500, () => socket.destroy(new Error("direct connection timeout")));
  });
}
function unixSocketRequest() {
  return new Promise((resolve) => {
    const socket = net.connect({ path: process.env.PROPRIO_TEST_HOST_SOCKET });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => resolve(error.code === "EPERM"));
    socket.setTimeout(1500, () => socket.destroy(new Error("unix socket timeout")));
  });
}
(async () => {
  const replacedPrivateViews = [
    replaceBrokerPath("/run/proprio-egress/broker.sock"),
    replaceBrokerPath(process.env.PROPRIO_TEST_BROKER_SOURCE),
  ].filter(Boolean).length;
  const unixDenied = await unixSocketRequest();
  const directPublic = await directAddressRequest("93.184.216.34", 443);
  const directMetadata = await directAddressRequest("169.254.169.254", 80);
  const allowed = await connectThrough("provider.example.test:443");
  const redirected = await connectThrough("redirect.example.test:443");
  if (replacedPrivateViews < 1 || !unixDenied || directPublic || directMetadata || allowed !== "HTTP/1.1 200 Connection Established" || redirected !== "HTTP/1.1 403 Forbidden") process.exit(9);
})().catch(() => process.exit(8));
`;
      const nested = buildRunnerEgressProviderSandboxCommand({
        command: process.execPath,
        args: ["-e", providerCode],
        seccompDescriptor: 3,
        inheritedDescriptorCount: 1,
        sandboxCommand: process.env.PROPRIO_TEST_BWRAP,
      });
      const guardianCode = `
const { spawn } = require("node:child_process");
const net = require("node:net");
const bridge = net.createServer((client) => {
  const upstream = net.connect(process.env.PROPRIO_RUNNER_EGRESS_SOCKET);
  client.pipe(upstream);
  upstream.pipe(client);
  client.once("error", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
});
bridge.once("error", () => process.exit(6));
bridge.listen(${RUNNER_EGRESS_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(${JSON.stringify(nested.command)}, ${JSON.stringify(nested.args)}, { stdio: ["ignore", "pipe", "pipe", 3], env: process.env });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", () => process.exit(7));
  child.once("exit", (code) => process.exit(code === null ? 7 : code));
});
`;
      const wrapped = buildRunnerEgressSandboxCommand({
        command: process.execPath,
        args: ["-e", guardianCode],
        socketDirectory: proxy.socketDirectory,
        workingDirectory: process.env.GITHUB_WORKSPACE ?? process.cwd(),
        inheritedDescriptorCount: 1,
        sandboxCommand: process.env.PROPRIO_TEST_BWRAP,
      });
      const execute = promisify(execFile);
      const result = await execute(wrapped.command, wrapped.args, {
        env: {
          ...process.env,
          ...wrapped.env,
          PROPRIO_TEST_HOST_SOCKET: hostSocketPath,
          PROPRIO_TEST_BROKER_SOURCE: proxy.socketPath,
        },
        stdio: ["ignore", "pipe", "pipe", proxy.seccompProfile.fd],
        timeout: 10_000,
      });
      expect(result.stderr).toBe("");
      expect(hostSocketConnections).toBe(0);
    },
  );
});

async function connectThroughProxy(socketPath: string, authority: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const client = net.connect({ path: socketPath });
    let response = "";
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.once("error", reject);
    client.once("connect", () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    client.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) finish(response.startsWith("HTTP/1.1 200"));
    });
    client.setTimeout(3_000, () => { client.destroy(new Error("Timed out waiting for proxy response")); });
  });
}
