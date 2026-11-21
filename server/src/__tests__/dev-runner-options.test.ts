import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDevRunnerOptions } from "../../../scripts/dev-runner-options.ts";

describe("applyDevRunnerOptions", () => {
  it("turns --data-dir into isolated Proprio paths and consumes the option", () => {
    const env: NodeJS.ProcessEnv = {};
    const cwd = path.join(os.tmpdir(), "proprio-dev-runner-options");
    const previousInstanceId = process.env.PROPRIO_INSTANCE_ID;
    process.env.PROPRIO_INSTANCE_ID = "ambient-test-instance";

    try {
      const result = applyDevRunnerOptions(
        ["--bind", "loopback", "--data-dir", "./tmp", "--future-option"],
        env,
        cwd,
      );

      const expectedHome = path.resolve(cwd, "tmp");
      expect(result).toEqual({
        forwardedArgs: ["--bind", "loopback", "--future-option"],
        dataDir: expectedHome,
      });
      expect(env.PROPRIO_HOME).toBe(expectedHome);
      expect(env.PROPRIO_INSTANCE_ID).toBe("default");
      expect(env.PROPRIO_CONFIG).toBe(
        path.join(expectedHome, "instances", "default", "config.json"),
      );
      expect(env.PROPRIO_CONTEXT).toBe(path.join(expectedHome, "context.json"));
    } finally {
      if (previousInstanceId === undefined) {
        delete process.env.PROPRIO_INSTANCE_ID;
      } else {
        process.env.PROPRIO_INSTANCE_ID = previousInstanceId;
      }
    }
  });

  it.each([
    ["short option", ["-d", "~/proprio-dev"]],
    ["equals form", ["--data-dir=~/proprio-dev"]],
  ])("supports the %s", (_label, args) => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyDevRunnerOptions(args, env, "/unused");

    expect(result.forwardedArgs).toEqual([]);
    expect(result.dataDir).toBe(path.join(os.homedir(), "proprio-dev"));
  });

  it("uses the selected instance for the default config path", () => {
    const env: NodeJS.ProcessEnv = { PROPRIO_INSTANCE_ID: "experiment" };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.PROPRIO_CONFIG).toBe(
      path.join("/isolated/home", "instances", "experiment", "config.json"),
    );
  });

  it("preserves explicit config and context paths", () => {
    const env: NodeJS.ProcessEnv = {
      PROPRIO_CONFIG: "/explicit/config.json",
      PROPRIO_CONTEXT: "/explicit/context.json",
    };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.PROPRIO_HOME).toBe("/isolated/home");
    expect(env.PROPRIO_CONFIG).toBe("/explicit/config.json");
    expect(env.PROPRIO_CONTEXT).toBe("/explicit/context.json");
  });

  it.each([["--data-dir"], ["-d"], ["--data-dir="]])(
    "rejects a missing value for %s",
    (...args) => {
      expect(() => applyDevRunnerOptions(args, {}, "/unused")).toThrow(
        /requires a value/,
      );
    },
  );
});
