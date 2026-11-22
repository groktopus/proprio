/** Treat current and historical receipts for skipped chat completion as quiet. */
export function isSupersededChatCompletion(errorCode: string | null | undefined): boolean {
  return errorCode === "chat_completion_superseded";
}
