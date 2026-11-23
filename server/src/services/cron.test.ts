import { describe, expect, it } from "vitest";
import { parseCron, validateCron } from "./cron.js";

describe("five-field cron expressions", () => {
  it("preserves exact, wildcard, range, step, and list syntax", () => {
    expect(parseCron("05,9-12/2,14/20 0-3 */10 1,6,12 1-5")).toEqual({
      minutes: [5, 9, 11, 14, 34, 54],
      hours: [0, 1, 2, 3],
      daysOfMonth: [1, 11, 21, 31],
      months: [1, 6, 12],
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
  });

  it.each([
    ["5,15oops * * * *", "minute"],
    ["0 2junk/3 * * *", "hour"],
    ["0 0 1x-15 * *", "day of month"],
    ["0 0 * 1-6x/2 *", "month"],
    ["0 0 * * 1/2/3", "day of week"],
    ["0 0 * * 5-2/2,1", "day of week"],
    ["0 0 * * */0", "day of week"],
    ["0 0 * * 7", "day of week"],
    ["0 0 * * 1,,5", "day of week"],
  ])("reports the malformed field in %s", (expression, field) => {
    expect(validateCron(expression)).toContain(`cron ${field} field`);
  });
});
