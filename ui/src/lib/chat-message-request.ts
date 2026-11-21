/** Retire the legacy body-keyed retry cache; submission receipts now own identity. */
export function clearLegacyChatMessageRequests(scope: string) {
  try {
    localStorage.removeItem(`proprio:agent-chat-pending:${scope}`);
  } catch {
    // Browser storage may be disabled.
  }
}
