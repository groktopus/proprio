import { expect, it, vi } from "vitest";

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected readonly ctx: DurableObjectState) {}
  },
}));

vi.mock("@cloudflare/sandbox", () => ({
  Files: class { stat = stat; },
  SandboxFileError: { is: (error: unknown) => error instanceof Error && error.name === "SandboxFileError" },
}));

import worker, { ProprioSandboxV1 } from "./index-v1.js";

function fixture() {
  const values = new Map<string, unknown>();
  const container = {
    running: false,
    images: { bridge: "v1-image" },
    start: vi.fn(() => { container.running = true; }),
    destroy: vi.fn(async () => { container.running = false; }),
    setInactivityTimeout: vi.fn(async () => undefined),
    exec: vi.fn(async (_argv: string[]) => ({
      exitCode: Promise.resolve(0),
      stdout: new Response("test output\n").body,
      stderr: new Response("test diagnostic\n").body,
    })),
  };
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) values.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix)))),
    setAlarm: vi.fn(async () => undefined),
    deleteAlarm: vi.fn(async () => undefined),
  };
  const doState = { container, storage } as unknown as DurableObjectState;
  const object = new ProprioSandboxV1(doState, {});
  const getByName = vi.fn(() => ({ fetch: (request: Request) => object.fetch(request) }));
  const env = { BRIDGE_AUTH_TOKEN: "fixture-key", ProprioSandboxV1: { getByName } } as unknown as Parameters<typeof worker.fetch>[1];
  function request(route: string, body: unknown, auth = "fixture-key", method = "POST") {
    return worker.fetch(new Request(`https://fixture.invalid/api/proprio-sandbox/v1${route}`, {
      method,
      headers: { Authorization: `Bearer ${auth}` },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: (promise: Promise<unknown>) => { void promise; } } as ExecutionContext);
  }
  return { object, request, container, storage, getByName };
}

it("checks the bearer token before looking up a sandbox", async () => {
  const test = fixture();
  const response = await test.request("/leases/acquire", { environmentId: "env", runId: "run" }, "wrong-key");
  expect(response.status).toBe(401);
  expect(test.getByName).not.toHaveBeenCalled();
});

it("preserves lease identity and checks the 1.0 sentinel without reviving a stopped container", async () => {
  const test = fixture();
  stat.mockReset();
  const options = { environmentId: "Example", runId: "run", reuseLease: true, keepAlive: true };
  const lease = await (await test.request("/leases/acquire", options)).json<{ providerLeaseId: string }>();
  expect(lease.providerLeaseId).toBe("pc-env-example");
  expect(test.container.start).toHaveBeenCalledOnce();
  expect(test.container.start).toHaveBeenCalledWith({ image: "v1-image", instance: "standard-2", enableInternet: true });
  expect(test.storage.setAlarm).toHaveBeenCalled();

  stat.mockResolvedValue({ type: "file", size: 16n });
  const resumed = await test.request("/leases/resume", { ...lease, keepAlive: true });
  expect(resumed.status).toBe(200);
  expect(test.container.start).toHaveBeenCalledOnce();
  expect(stat).toHaveBeenCalledWith("/workspace/proprio/.proprio-lease.json", { signal: expect.any(AbortSignal) });

  const release = await test.request("/leases/release", { ...lease, reuseLease: true });
  expect(release.status).toBe(200);
  expect(test.container.destroy).not.toHaveBeenCalled();
  await test.request(`/leases/${lease.providerLeaseId}`, undefined, "fixture-key", "DELETE");
  expect(test.container.destroy).toHaveBeenCalledOnce();
  await test.object.alarm();
  const missing = await test.request("/leases/resume", { ...lease, keepAlive: true });
  expect(missing.status).toBe(409);
  expect(test.container.start).toHaveBeenCalledOnce();
});

it("streams both channels and keeps named session environment separate from default commands", async () => {
  const test = fixture();
  const command = { providerLeaseId: "lease-id", command: "printf", sessionId: "custom", sessionStrategy: "named" };
  const named = await test.request("/exec", { ...command, env: { SESSION_ONLY: "value" }, streamOutput: true });
  expect(named.headers.get("Content-Type")).toBe("text/event-stream");
  const output = await named.text();
  expect(output).toContain("event: stdout");
  expect(output).toContain("event: stderr");
  expect(output).toContain("event: complete");
  await test.request("/exec", command);
  await test.request("/exec", { ...command, sessionStrategy: "default" });
  const scripts = test.container.exec.mock.calls.map(([argv]) => argv.at(-1)!);
  expect(scripts[0]).toContain("SESSION_ONLY='value'");
  expect(scripts[1]).toContain("SESSION_ONLY='value'");
  expect(scripts[2]).not.toContain("SESSION_ONLY");
});

it.each(["named", "default"] as const)("observes command timeout and cleans up only the applicable %s scope", async sessionStrategy => {
  const test = fixture();
  vi.useFakeTimers();
  try {
    let started!: () => void;
    let exit!: (code: number) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const exitCode = new Promise<number>(resolve => { exit = resolve; });
    const kill = vi.fn(() => exit(143));
    test.container.exec.mockImplementationOnce(async () => {
      started();
      return { exitCode, kill, stdout: null, stderr: null };
    });
    const pending = test.request("/exec", { providerLeaseId: "lease-id", command: "sleep", timeoutMs: 100, sessionStrategy });
    await ready;
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ exitCode: null, timedOut: true });
    expect(kill).toHaveBeenCalledExactlyOnceWith(15);
    if (sessionStrategy === "named") {
      expect(test.storage.delete).toHaveBeenCalledWith("session:proprio");
      expect(test.container.destroy).not.toHaveBeenCalled();
    } else {
      expect(test.container.destroy).toHaveBeenCalledOnce();
    }
  } finally {
    vi.useRealTimers();
  }
});

it("rejects queued same-session commands after destruction without restarting the container", async () => {
  const test = fixture();
  let started!: () => void;
  let finish!: (code: number) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const exitCode = new Promise<number>(resolve => { finish = resolve; });
  test.container.exec.mockImplementationOnce(async () => {
    started();
    return { exitCode, stdout: null, stderr: null };
  });
  const inner = (path: string, body?: unknown) => test.object.fetch(new Request(`https://sandbox.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }));
  const command = { command: "sleep", sessionStrategy: "named", sessionId: "queue" };
  const executing = await inner("/execute", { ...command, commandId: "first" });
  await ready;
  const queued = await inner("/execute", { ...command, commandId: "queued" });
  expect(test.container.exec).toHaveBeenCalledTimes(1);
  await inner("/destroy");
  finish(143);
  await executing.text();
  expect(await queued.text()).toContain("destroyed before command startup");
  expect(test.container.start).toHaveBeenCalledOnce();
  expect(test.container.exec).toHaveBeenCalledTimes(1);
});

it("requests container process cancellation when the public SSE consumer disconnects", async () => {
  const test = fixture();
  let started!: () => void;
  let finish!: (code: number) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const exitCode = new Promise<number>(resolve => { finish = resolve; });
  const kill = vi.fn(() => finish(143));
  test.container.exec.mockImplementationOnce(async () => {
    started();
    return { exitCode, kill, stdout: null, stderr: null };
  });
  const response = await test.request("/exec", { providerLeaseId: "lease-id", command: "sleep", streamOutput: true });
  await ready;
  await response.body!.cancel();
  await vi.waitFor(() => expect(kill).toHaveBeenCalledExactlyOnceWith(15));
  expect(test.container.destroy).not.toHaveBeenCalled();
});
