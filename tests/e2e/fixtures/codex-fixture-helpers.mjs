export const cliProbeResponse = () => JSON.stringify({
  type: "item.completed", item: { type: "agent_message", text: "hello" },
});

export function resultText(result) {
  if (result?.isError) throw new Error(JSON.stringify(result));
  const content = result?.data?.content ?? result?.contentItems ?? result?.content ?? [];
  if (!Array.isArray(content)) throw new Error("Tool returned no text content");
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}
