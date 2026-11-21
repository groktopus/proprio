import { describe, expect, it } from "vitest";
import { sanitizeInheritedProprioEnv } from "./server-utils.js";

describe("sanitizeInheritedProprioEnv", () => {
  it("drops the host-only Proprio CLI command pointer", () => {
    expect(sanitizeInheritedProprioEnv({
      PROPRIO_CMD: "node /missing/proprio/dist/index.js",
      PROPRIO_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PROPRIO_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});
