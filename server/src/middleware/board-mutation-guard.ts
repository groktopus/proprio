import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the host used for same-origin checks without letting a direct client
 * promote its own X-Forwarded-Host value into the trusted-origin set. Express
 * compiles the operator's TRUST_PROXY setting into `trust proxy fn`; only a
 * trusted immediate peer may supply the forwarded host.
 */
export function boardRequestHost(
  host: string | undefined,
  forwardedHost: string | undefined,
  remoteAddress: string | undefined,
  trustProxy: ((address: string, hop: number) => boolean) | undefined,
): string | undefined {
  if (remoteAddress && typeof trustProxy === "function" && trustProxy(remoteAddress, 0)) {
    return forwardedHost?.split(",")[0]?.trim() || host?.trim();
  }
  return host?.trim();
}

export function trustedBoardRequestOrigin(input: {
  origin: string | undefined;
  host: string | undefined;
  configuredOrigin?: string | null;
  allowDevOrigins?: boolean;
}): string | null {
  const origin = parseOrigin(input.origin);
  if (!origin) return null;
  const host = input.host?.toLowerCase();
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return origin;
  if (origin === parseOrigin(input.configuredOrigin ?? process.env.PROPRIO_PUBLIC_URL?.trim())) return origin;
  if (input.allowDevOrigins && DEFAULT_DEV_ORIGINS.includes(origin)) return origin;
  return null;
}

/**
 * Return the browser origin only when it is the same origin Proprio's CSRF
 * guard accepts for this request. Callers may use this as browser-reachability
 * evidence, but must still apply any protocol-specific constraints (for
 * example OAuth requiring HTTPS outside loopback).
 */
export function trustedBoardMutationOrigin(req: Request): string | null {
  return trustedBoardRequestOrigin({
    origin: req.header("origin") ?? req.header("referer"),
    host: boardRequestHost(req.header("host"), req.header("x-forwarded-host"), req.socket?.remoteAddress,
      req.app?.get("trust proxy fn")),
    allowDevOrigins: req.actor?.source !== "local_implicit",
  });
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Explicit credentials and trusted server-to-server calls have no ambient browser authority.
    if (
      req.actor.source === "board_key"
      || req.actor.source === "mcp_oauth"
      || req.actor.source === "cloud_tenant"
      || req.actor.source === "cloud_control"
    ) {
      next();
      return;
    }

    if (req.actor.source === "local_implicit"
      && ["origin", "referer", "sec-fetch-site"].every((name) => req.header(name) === undefined)) {
      next();
      return;
    }

    if (!trustedBoardMutationOrigin(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
