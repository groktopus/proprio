import { describe, expect, it, vi } from "vitest";
import { checkForUpdateNotice, isUpdateNoticeEnabled } from "../update-notice.js";

describe("standalone update notice", () => {
  it("does not contact a package registry before Proprio has a published distribution", async () => {
    const fetchImpl = vi.fn();
    expect(isUpdateNoticeEnabled()).toBe(false);
    expect(await checkForUpdateNotice({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
