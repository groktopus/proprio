import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProprioApiClient } from "./client.js";
import { readConfigFromEnv, type ProprioMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createProprioMcpServer(config: ProprioMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "proprio",
    version: "0.1.0",
  });

  const client = new ProprioApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: ProprioMcpConfig = readConfigFromEnv()) {
  const { server } = createProprioMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
