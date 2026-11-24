/**
 * Shared base-URL helpers used by both server startup (index.ts) and worktree
 * config materialization (worktree-config.ts). Keeping a single source of truth
 * for host classification and port rewriting prevents the two paths from drifting.
 */

export function isLoopbackHost(host: string): boolean {
  // Strip surrounding brackets so a URL hostname form ("[::1]") matches too.
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Rewrite the port of any explicit-port base URL to `port`, leaving portless and
 * unparseable URLs untouched.
 *
 * Used by the worktree path: a worktree is a distinct instance on its own server
 * port, so its advertised base URL must follow that port even for a non-loopback
 * host (worktrees are reachable at the same host on their own port).
 */
export function rewriteUrlPort(rawUrl: string | undefined, port: number): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
    if (!parsed.port) return rawUrl;
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Keep a loopback URL that advertises a separate port, such as a Docker
 * publishing port. Only rewrite local URLs that followed the requested
 * server listener when detect-port moves that listener.
 */
export function rewriteLoopbackUrlPort(
  rawUrl: string | undefined,
  requestedPort: number,
  listenPort: number,
): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    if (!isLoopbackHost(parsed.hostname) || parsed.port !== String(requestedPort)) return rawUrl;
    parsed.port = String(listenPort);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
