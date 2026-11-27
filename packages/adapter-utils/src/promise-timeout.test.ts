import { afterEach, describe, expect, it, vi } from "vitest";
import { withPromiseTimeout } from "./promise-timeout.js";

afterEach(() => vi.useRealTimers());

describe("withPromiseTimeout", () => {
  it("returns a settled operation and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withPromiseTimeout(Promise.resolve("ready"), 100, () => new Error("late"))).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the caller's timeout error and clears its timer", async () => {
    vi.useFakeTimers();
    const operation = new Promise<never>(() => {});
    const result = withPromiseTimeout(operation, 25, () => Object.assign(new Error("probe timeout"), { code: "PROBE_TIMEOUT" }));
    const assertion = expect(result).rejects.toMatchObject({ message: "probe timeout", code: "PROBE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an operation rejection and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withPromiseTimeout(Promise.reject(new Error("operation failed")), 100, () => new Error("late")))
      .rejects.toThrow("operation failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
