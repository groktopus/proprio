import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export { RUNNER_EGRESS_ALLOWLIST_ENV } from "../../runner-egress.js";

export const RUNNER_EGRESS_SOCKET_ENV = "PROPRIO_RUNNER_EGRESS_SOCKET";
export const RUNNER_EGRESS_SECCOMP_FD_ENV = "PROPRIO_RUNNER_EGRESS_SECCOMP_FD";
export const RUNNER_EGRESS_CREDENTIAL_FENCES_ENV = "PROPRIO_ACPX_CREDENTIAL_FENCES_ENABLED";
export const RUNNER_EGRESS_PROXY_PORT = 31_339;
const SANDBOX_EGRESS_SOCKET_DIRECTORY = "/run/proprio-egress";

const SOCKET_DIRECTORY_PREFIX = "prp-egress-";
const MAX_POLICY_BYTES = 16 * 1024;
const MAX_RULES = 128;
const IPV4_BLOCKLIST = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) IPV4_BLOCKLIST.addSubnet(address, prefix, "ipv4");

const IPV6_BLOCKLIST = new net.BlockList();
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) IPV6_BLOCKLIST.addSubnet(address, prefix, "ipv6");

export interface RunnerEgressPolicy {
  allowlist: readonly string[];
}

interface EgressRule {
  hostname: string;
  port: string | null;
}

export interface RunnerEgressProxy {
  socketDirectory: string;
  socketPath: string;
  seccompProfile: FileHandle;
  close(): Promise<void>;
}

function providerSeccompProgram(): Buffer {
  const syscallNumbers = process.arch === "x64"
    ? { arch: 0xc000_003e, socket: 41, socketpair: 53, ioUringSetup: 425 }
    : process.arch === "arm64"
      ? { arch: 0xc000_00b7, socket: 198, socketpair: 199, ioUringSetup: 425 }
      : null;
  if (syscallNumbers === null) throw new Error(`Runner egress seccomp is unsupported on Linux architecture ${process.arch}.`);
  const instructions: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, syscallNumbers.arch],
    [0x06, 0, 0, 0x0005_0001], // fail closed on an unexpected syscall ABI
    [0x20, 0, 0, 0], // seccomp_data.nr
    [0x54, 0, 0, 0x4000_0000], // mask the x32 syscall ABI bit
    [0x15, 1, 0, 0],
    [0x06, 0, 0, 0x0005_0001], // reject x32 ABI syscalls
    [0x20, 0, 0, 0], // reload syscall number
    [0x15, 0, 5, syscallNumbers.socket],
    [0x20, 0, 0, 16], // load args[0] (domain)
    [0x15, 2, 0, 2], // allow AF_INET
    [0x15, 1, 0, 10], // allow AF_INET6
    [0x06, 0, 0, 0x0005_0001], // reject all other socket domains
    [0x20, 0, 0, 0],
    [0x15, 0, 1, syscallNumbers.socketpair],
    [0x06, 0, 0, 0x0005_0001], // no socketpair, including AF_UNIX
    [0x20, 0, 0, 0],
    [0x15, 0, 1, syscallNumbers.ioUringSetup],
    [0x06, 0, 0, 0x0005_0001], // prevent io_uring from bypassing socket filters
    [0x06, 0, 0, 0x7fff_0000], // SECCOMP_RET_ALLOW
  ];
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    program.writeUInt16LE(code, offset);
    program.writeUInt8(jt, offset + 2);
    program.writeUInt8(jf, offset + 3);
    program.writeUInt32LE(k, offset + 4);
  });
  return program;
}

function parseRule(value: unknown, index: number): EgressRule {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runner egress allowlist entry ${index} must be a non-empty string.`);
  const raw = value.trim();
  const authority = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3).split(/[/?#]/, 1)[0]! : raw.split(/[/?#]/, 1)[0]!;
  let parsed: URL;
  try { parsed = new URL(raw.includes("://") ? raw : `https://${raw}`); }
  catch { throw new Error(`Runner egress allowlist entry ${index} must be a hostname, hostname:port, or HTTPS origin.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Runner egress allowlist entry ${index} must not include credentials, a path, query, or fragment.`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "*" || hostname.startsWith("*.") || net.isIP(hostname) !== 0) {
    throw new Error(`Runner egress allowlist entry ${index} must be an exact DNS hostname; wildcards and IP literals are not allowed.`);
  }
  const explicitPort = /:(\d+)$/.exec(authority)?.[1] ?? null;
  if (authority.endsWith(":") || (explicitPort !== null && (Number(explicitPort) < 1 || Number(explicitPort) > 65535))) {
    throw new Error(`Runner egress allowlist entry ${index} has an invalid port.`);
  }
  return { hostname, port: explicitPort === null ? null : String(Number(explicitPort)) };
}

/** Unset disables this optional deployment policy. An explicit [] denies all network access. */
export function parseRunnerEgressPolicy(raw: string | undefined): RunnerEgressPolicy | null {
  if (raw === undefined) return null;
  if (Buffer.byteLength(raw) > MAX_POLICY_BYTES) throw new Error("Runner egress allowlist exceeds its size limit.");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Runner egress allowlist must be a JSON array of exact host rules."); }
  if (!Array.isArray(value) || value.length > MAX_RULES) throw new Error("Runner egress allowlist must be an array with at most 128 entries.");
  const rules = value.map(parseRule);
  const unique = new Set(rules.map(({ hostname, port }) => `${hostname}${port ? `:${port}` : ""}`));
  return Object.freeze({ allowlist: Object.freeze([...unique]) });
}

function parseRules(allowlist: readonly string[]): EgressRule[] {
  return allowlist.map(parseRule);
}

function allowedTarget(hostname: string, port: string, rules: readonly EgressRule[]): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return rules.some((rule) => rule.hostname === normalized && (rule.port === null || rule.port === port));
}

function isPublicAddress(address: string, family: number): boolean {
  try {
    if (family === 4) return net.isIP(address) === 4 && !IPV4_BLOCKLIST.check(address, "ipv4");
    if (family !== 6 || net.isIP(address) !== 6 || !address.includes(":")) return false;
    if (IPV6_BLOCKLIST.check(address, "ipv6")) return false;
    const expanded = address.toLowerCase().split("%", 1)[0]!;
    const halves = expanded.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    if (halves.length > 2) return false;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return false;
    const groups = [...left, ...Array(missing).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
    // Only global unicast 2000::/3 can be a provider destination. Special and
    // translation prefixes inside this range are excluded by IPV6_BLOCKLIST.
    return (Number.parseInt(groups[0]!, 16) & 0xe000) === 0x2000;
  } catch {
    return false;
  }
}

function denied(response: net.Socket): void {
  response.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function parseConnectAuthority(authority: string): { hostname: string; port: string } | null {
  try {
    const target = new URL(`https://${authority}`);
    if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) return null;
    const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const port = target.port || "443";
    if (!hostname || net.isIP(hostname) !== 0 || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
    return { hostname, port };
  } catch { return null; }
}

function safeSocketPath(directory: string): string {
  const socketPath = path.join(directory, "broker.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new Error("Runner egress broker socket path exceeds the Linux Unix socket limit.");
  return socketPath;
}

export async function startRunnerEgressProxy(
  policy: RunnerEgressPolicy,
  dependencies: {
    lookup?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
    connect?: (target: { host: string; family: number; port: number }) => net.Socket;
  } = {},
): Promise<RunnerEgressProxy> {
  if (process.platform !== "linux") throw new Error("Runner egress confinement is supported only on Linux.");
  const rules = parseRules(policy.allowlist);
  const lookup = dependencies.lookup ?? (async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? ((target) => net.connect(target));
  const directory = await mkdtemp(path.join("/tmp", SOCKET_DIRECTORY_PREFIX));
  const socketPath = safeSocketPath(directory);
  const seccompProfilePath = path.join(directory, "provider-no-unix-sockets.bpf");
  let seccompProfile: FileHandle;
  try {
    await writeFile(seccompProfilePath, providerSeccompProgram(), { mode: 0o600 });
    seccompProfile = await open(seccompProfilePath, "r");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const activeSockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { Connection: "close", "Content-Length": "0" }).end();
  });
  server.on("connect", async (request, client, head) => {
    const target = parseConnectAuthority(request.url ?? "");
    if (!target || !allowedTarget(target.hostname, target.port, rules)) { denied(client); return; }
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        lookup(target.hostname),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("DNS lookup timed out")), 5_000);
          timeout.unref();
        }),
      ]);
    } catch { denied(client); return; }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
    if (client.destroyed || addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address, item.family))) {
      denied(client);
      return;
    }
    const peer = addresses[0]!;
    let upstream: net.Socket;
    try { upstream = connect({ host: peer.address, family: peer.family, port: Number(target.port) }); }
    catch { denied(client); return; }
    let established = false;
    activeSockets.add(upstream);
    upstream.setTimeout(5_000, () => upstream.destroy(new Error("Runner egress upstream connect timed out.")));
    upstream.once("close", () => activeSockets.delete(upstream));
    upstream.once("connect", () => {
      if (client.destroyed) { upstream.destroy(); return; }
      established = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => { if (established) client.destroy(); else denied(client); });
    client.once("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await seccompProfile.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketDirectory: directory,
    socketPath,
    seccompProfile,
    close: async () => {
      for (const socket of activeSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await seccompProfile.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function buildRunnerEgressSandboxCommand(input: {
  command: string;
  args: readonly string[];
  socketDirectory: string | null;
  workingDirectory: string;
  inheritedDescriptorCount: number;
  sandboxCommand?: string;
}): { command: string; args: string[]; env: Record<string, string | undefined> } {
  if (process.platform !== "linux") throw new Error("Runner egress confinement is supported only on Linux.");
  if (!Number.isSafeInteger(input.inheritedDescriptorCount) || input.inheritedDescriptorCount < 0 || input.inheritedDescriptorCount > 256) {
    throw new Error("Runner egress descriptor count is invalid.");
  }
  const sandbox = input.sandboxCommand ?? "/usr/bin/bwrap";
  if (!path.isAbsolute(sandbox)) throw new Error("Runner egress sandbox command must be absolute.");
  if (!path.isAbsolute(input.workingDirectory)) throw new Error("Runner egress working directory must be absolute.");
  const args = [
    "--die-with-parent", "--unshare-net", "--cap-add", "CAP_NET_ADMIN",
    "--bind", "/", "/", "--tmpfs", "/run",
    "--dir", SANDBOX_EGRESS_SOCKET_DIRECTORY,
  ];
  const env: Record<string, string | undefined> = {};
  if (input.socketDirectory !== null) {
    args.push("--bind", input.socketDirectory, SANDBOX_EGRESS_SOCKET_DIRECTORY);
    env[RUNNER_EGRESS_SOCKET_ENV] = path.join(SANDBOX_EGRESS_SOCKET_DIRECTORY, "broker.sock");
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = `http://127.0.0.1:${RUNNER_EGRESS_PROXY_PORT}`;
    env.NO_PROXY = "";
    env.no_proxy = "";
  } else {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  args.push(
    "--dir", "/proprio-work", "--bind", input.workingDirectory, "/proprio-work",
    "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--chdir", "/proprio-work",
  );
  if (input.inheritedDescriptorCount > 0) args.push("--preserve-fds", String(input.inheritedDescriptorCount));
  args.push(
    "--", "/bin/sh", "-c", "/usr/sbin/ip link set lo up && exec \"$@\"", "proprio-egress",
    input.command, ...input.args,
  );
  return { command: sandbox, args, env };
}

export function buildRunnerEgressProviderSandboxCommand(input: {
  command: string;
  args: readonly string[];
  seccompDescriptor: number;
  inheritedDescriptorCount: number;
  sandboxCommand?: string;
}): { command: string; args: string[] } {
  if (process.platform !== "linux") throw new Error("Runner egress confinement is supported only on Linux.");
  if (!Number.isSafeInteger(input.seccompDescriptor) || input.seccompDescriptor < 3) throw new Error("Runner egress seccomp descriptor is invalid.");
  if (!Number.isSafeInteger(input.inheritedDescriptorCount) || input.inheritedDescriptorCount < 0 || input.inheritedDescriptorCount > 256) {
    throw new Error("Runner egress descriptor count is invalid.");
  }
  const sandbox = input.sandboxCommand ?? "/usr/bin/bwrap";
  if (!path.isAbsolute(sandbox)) throw new Error("Runner egress provider sandbox command must be absolute.");
  const args = [
    "--die-with-parent", "--share-net", "--unshare-pid", "--bind", "/", "/",
    "--proc", "/proc", "--tmpfs", "/run/proprio-egress", "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp", "--cap-drop", "ALL", "--seccomp", String(input.seccompDescriptor),
  ];
  if (input.inheritedDescriptorCount > 0) args.push("--preserve-fds", String(input.inheritedDescriptorCount));
  args.push("--", input.command, ...input.args);
  return { command: sandbox, args };
}
