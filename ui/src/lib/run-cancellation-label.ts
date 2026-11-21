export function runCancellationLabel(input: { grokWork?: boolean; isFailed: boolean; isPending: boolean }): string {
  if (input.grokWork) return input.isPending ? "Stopping Proprio work…" : "Stop Proprio work";
  if (input.isFailed) return input.isPending ? "Stopping…" : "Stop";
  return input.isPending ? "Cancelling…" : "Cancel";
}
