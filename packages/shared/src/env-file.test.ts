import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it("pins minimal and JSON value encoding", () => {
    expect(encodeEnvValue("plain-value", "minimal")).toBe("plain-value");
    expect(encodeEnvValue("#439edb", "minimal")).toBe('"#439edb"');
    expect(encodeEnvValue("plain-value", "json")).toBe('"plain-value"');
  });

  it("preserves unrelated content and CRLF while updating every stale duplicate", () => {
    const original = [
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      "export PROPRIO_HOME = '/old path'  # managed path",
      "PROPRIO_DUPLICATE=stale",
      'PROPRIO_DUPLICATE="current"',
      "TRAILING=untouched",
      "",
    ].join("\r\n");

    const updated = updateEnvFileContents(
      original,
      {
        PROPRIO_HOME: "/new path",
        PROPRIO_DUPLICATE: "current",
        PROPRIO_WORKTREE_COLOR: "#439edb",
      },
      { valueEncoding: "minimal" },
    );

    expect(updated).toBe([
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      'export PROPRIO_HOME = "/new path"  # managed path',
      "PROPRIO_DUPLICATE=current",
      'PROPRIO_DUPLICATE="current"',
      "TRAILING=untouched",
      'PROPRIO_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("uses JSON encoding for changed values without re-encoding current assignments", () => {
    const original = [
      "PROPRIO_CURRENT=plain-value",
      "PROPRIO_CHANGED=old",
      "UNKNOWN=\"operator value\"",
      "",
    ].join("\n");

    expect(
      updateEnvFileContents(
        original,
        {
          PROPRIO_CURRENT: "plain-value",
          PROPRIO_CHANGED: "new",
          PROPRIO_ADDED: "added",
        },
        { valueEncoding: "json" },
      ),
    ).toBe([
      "PROPRIO_CURRENT=plain-value",
      'PROPRIO_CHANGED="new"',
      'UNKNOWN="operator value"',
      'PROPRIO_ADDED="added"',
      "",
    ].join("\n"));
  });

  it("does not treat an unquoted dotenv comment as the managed value", () => {
    expect(
      updateEnvFileContents(
        ["PROPRIO_COLOR=#439edb", "PROPRIO_HOME=old# keep this comment"].join("\n"),
        {
          PROPRIO_COLOR: "#439edb",
          PROPRIO_HOME: "new",
        },
        { valueEncoding: "minimal" },
      ),
    ).toBe(
      ['PROPRIO_COLOR="#439edb"#439edb', "PROPRIO_HOME=new# keep this comment"].join("\n"),
    );
  });

  it("is a no-op when every managed duplicate is already current", () => {
    const original = [
      "export PROPRIO_HOME = '/same path' # first",
      'PROPRIO_HOME="/same path"',
      "UNKNOWN=value",
    ].join("\n");

    expect(updateEnvFileContents(original, { PROPRIO_HOME: "/same path" })).toBe(original);
  });
});
