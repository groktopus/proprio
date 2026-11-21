import { describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import {
  getOrCreateProprioReactRoot,
  type ProprioReactRootHost,
} from "./react-root";

describe("getOrCreateProprioReactRoot", () => {
  it("reuses the existing root when the entry module runs again", () => {
    const host: ProprioReactRootHost = {};
    const container = {} as Parameters<typeof getOrCreateProprioReactRoot>[1];
    const root = { render: vi.fn(), unmount: vi.fn() } as unknown as Root;
    const createRoot = vi.fn(() => root);

    expect(getOrCreateProprioReactRoot(host, container, createRoot)).toBe(root);
    expect(getOrCreateProprioReactRoot(host, container, createRoot)).toBe(root);
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(container);
  });
});
