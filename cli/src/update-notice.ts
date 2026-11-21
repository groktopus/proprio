export function isUpdateNoticeEnabled(_configPath?: string): boolean { return false; }
export async function checkForUpdateNotice(_options: { configPath?: string; now?: number; fetchImpl?: typeof fetch; cachePath?: string } = {}): Promise<string | null> { return null; }
export async function printUpdateNotice(_configPath?: string): Promise<void> {}
