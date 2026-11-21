import { describe, expect, it } from "vitest";
import { connectionAgentInstructionsSchema } from "./connection-instructions.js";
import { isSameProprioInstance, proprioPeerAgentInstructions, proprioPeerFromMcpUrl, proprioPeerInstructionTemplate } from "./proprio-peer.js";

describe("proprioPeerFromMcpUrl", () => {
  it.each([
    ["https://acme.paperclip.app/mcp/proprio", "acme", "acme Proprio"],
    ["https://paperclip.staging.paperclip.app/mcp/proprio/", "staging", "staging Proprio"],
    ["https://pc.example.com/mcp/proprio", "pc", "pc Proprio"],
    ["https://example.com/mcp/proprio", "example", "example Proprio"],
    ["http://localhost:3101/mcp/proprio", "localhost-3101", "localhost-3101 Proprio"],
    ["http://127.0.0.1:3101/mcp/proprio", "127-0-0-1-3101", "127-0-0-1-3101 Proprio"],
    ["https://paperclip.app/mcp/proprio", "proprio", "Proprio paperclip.app"],
  ])("names %s after the instance it reaches", (url, label, name) => {
    expect(proprioPeerFromMcpUrl(url)).toMatchObject({ label, name });
  });

  it("derives a tool prefix from the address, with the distinctive part first", () => {
    expect(proprioPeerFromMcpUrl("https://acme.paperclip.app/mcp/proprio")?.toolNamespace).toBe("acme-proprio");
    expect(proprioPeerFromMcpUrl("https://paperclip.app/mcp/proprio")?.toolNamespace).toBe("proprio");
  });

  it.each([
    "https://acme.paperclip.app/mcp",
    "https://acme.paperclip.app/mcp/proprio/extra",
    "https://mcp.example.com/sse",
    "ftp://acme.paperclip.app/mcp/proprio",
    "not a url",
    "",
    null,
  ])("ignores %s", (url) => {
    expect(proprioPeerFromMcpUrl(url)).toBeNull();
  });
});

describe("isSameProprioInstance", () => {
  const peer = (url: string) => proprioPeerFromMcpUrl(url)!;

  it("matches the instance's own public origin", () => {
    expect(isSameProprioInstance(peer("https://acme.paperclip.app/mcp/proprio"), [null, "https://acme.paperclip.app"])).toBe(true);
  });

  it("treats loopback hostnames on the same port as the same instance", () => {
    expect(isSameProprioInstance(peer("http://127.0.0.1:3100/mcp/proprio"), ["http://localhost:3100"])).toBe(true);
  });

  it("keeps another local instance on a different port distinct", () => {
    expect(isSameProprioInstance(peer("http://localhost:3101/mcp/proprio"), ["http://localhost:3100"])).toBe(false);
  });

  it("keeps another hosted instance distinct", () => {
    expect(isSameProprioInstance(peer("https://bob.paperclip.app/mcp/proprio"), ["https://acme.paperclip.app", "not a url"])).toBe(false);
  });
});

describe("proprioPeerAgentInstructions", () => {
  it("names the other instance, steers own work back home, and fits the instruction limits", () => {
    const instructions = proprioPeerAgentInstructions(peer());
    expect(connectionAgentInstructionsSchema.parse(instructions)).toEqual(instructions);
    expect(instructions.enabled).toBe(true);
    expect(instructions.template).toEqual({ id: "proprio.peer", version: 1 });
    expect(instructions.text).toBe(proprioPeerInstructionTemplate(peer()).text);
    expect(instructions.text).toContain("https://acme.paperclip.app");
    expect(instructions.text).toContain("not the Proprio you work in");
    expect(instructions.text).toContain("keep using your own Proprio tools");
  });

  function peer() {
    return proprioPeerFromMcpUrl("https://acme.paperclip.app/mcp/proprio")!;
  }
});
