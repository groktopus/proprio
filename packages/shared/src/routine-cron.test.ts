import { describe, expect, it } from "vitest";
import { nextRoutineCronFire } from "./routine-cron.js";

describe("routine cron", () => {
  it("treats two restricted day fields as alternatives", () => {
    const after = new Date("2026-11-16T10:00:00Z");
    expect(nextRoutineCronFire("0 9 1 * 1", "UTC", after)?.toISOString())
      .toBe("2026-11-23T09:00:00.000Z");
  });

  it("uses the restricted field when the other day field is wildcard", () => {
    expect(nextRoutineCronFire("0 9 15 * *", "UTC", new Date("2026-06-09T10:00:00Z"))?.toISOString())
      .toBe("2026-06-15T09:00:00.000Z");
    expect(nextRoutineCronFire("0 9 * * 1", "UTC", new Date("2026-06-09T10:00:00Z"))?.toISOString())
      .toBe("2026-06-15T09:00:00.000Z");
  });

  it("uses the same day-field rules in the requested timezone", () => {
    expect(nextRoutineCronFire("0 9 15 * 5", "America/New_York", new Date("2026-06-09T10:00:00Z"))?.toISOString())
      .toBe("2026-06-12T13:00:00.000Z");
  });
});
