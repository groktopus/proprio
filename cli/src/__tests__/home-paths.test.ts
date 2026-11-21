import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveProprioHomeDir,
  resolveProprioInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.proprio and default instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-home-paths-"));
    process.env.PROPRIO_HOME = home;
    delete process.env.PROPRIO_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(home);
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(home, "instances", "default", "config.json"));
  });

  it("supports PROPRIO_HOME and explicit instance ids", () => {
    process.env.PROPRIO_HOME = "~/proprio-home";

    const home = resolveProprioHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "proprio-home"));
    expect(resolveProprioInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveProprioInstanceId("bad/id")).toThrow(/Invalid PROPRIO_INSTANCE_ID/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
