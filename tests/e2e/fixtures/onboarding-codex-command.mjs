export function resolveCodexCommand() {
  const command = process.env.PROPRIO_ONBOARDING_CODEX_COMMAND;
  if (!command) throw new Error('Controlled onboarding Codex command is unavailable');
  return command;
}
export const resolvePinnedCodexCommand = resolveCodexCommand;
