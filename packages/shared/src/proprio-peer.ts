import { defaultConnectionAgentInstructions, type ConnectionAgentInstructions, type ConnectionInstructionTemplate } from "./connection-instructions.js";

/**
 * Another Proprio instance connected through "Connect your own MCP server".
 *
 * Every Proprio serves its assistant connection at the same path. Recognizing
 * that address lets setup name the connection after the instance it reaches and
 * tell agents those tools act somewhere else. Agents already have their own
 * Proprio tools, so without this the two sets look alike: same names, same
 * product in every description.
 *
 * Everything here is derived from the address the person typed. Nothing the
 * remote server returns is used, so a remote instance cannot choose the name or
 * the instructions agents read.
 */
export const PROPRIO_PEER_MCP_PATH = "/mcp/proprio";

export interface ProprioPeer {
  /** `https://acme.example.invalid` */
  origin: string;
  /** `acme.example.invalid`, with a port when one is present. */
  host: string;
  /** Short distinctive part of the host: `acme`, `staging`, `localhost-3101`. */
  label: string;
  /** Default connection name. The label comes first so it reads distinctively. */
  name: string;
  /** Tool-name prefix agents see. Derived from the address, so renaming never changes it. */
  toolNamespace: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const GENERIC_HOST_LABELS = new Set(["www", "proprio"]);

function isIpAddress(hostname: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

function hostLabel(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname) || isIpAddress(hostname) || !hostname.includes(".")) {
    const base = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "proprio";
    return url.port ? `${base}-${url.port}` : base;
  }
  const parts = hostname.split(".");
  // Drop the registrable domain (approximated as the last two labels) and
  // generic labels, so `acme.example.invalid` becomes `acme` and
  // `proprio.staging.example.invalid` becomes `staging`.
  const subdomain = (parts.length >= 3 ? parts.slice(0, -2) : parts.slice(0, -1))
    .filter((part) => !GENERIC_HOST_LABELS.has(part));
  const chosen = subdomain.length > 0 ? subdomain : parts.slice(0, -1);
  const label = chosen.join("-").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return label.slice(0, 40) || "proprio";
}

/** The other Proprio this MCP address points at, or null for any other server. */
export function proprioPeerFromMcpUrl(value: string | null | undefined): ProprioPeer | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname.replace(/\/+$/, "") !== PROPRIO_PEER_MCP_PATH) return null;
  const label = hostLabel(url);
  return {
    origin: url.origin,
    host: url.host,
    label,
    name: label === "proprio" ? `Proprio ${url.host}` : `${label} Proprio`,
    toolNamespace: label === "proprio" ? "proprio" : `${label}-proprio`,
  };
}

function loopbackEquivalent(url: URL) {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return LOOPBACK_HOSTNAMES.has(hostname) ? `${url.protocol}//loopback:${port}` : `${url.protocol}//${url.host.toLowerCase()}`;
}

/** True when the peer is this same instance, under any of its own origins. */
export function isSameProprioInstance(peer: ProprioPeer, ownOrigins: Array<string | null | undefined>): boolean {
  const target = loopbackEquivalent(new URL(peer.origin));
  return ownOrigins.some((origin) => {
    if (!origin) return false;
    try {
      return loopbackEquivalent(new URL(origin)) === target;
    } catch {
      return false;
    }
  });
}

export const PROPRIO_PEER_INSTRUCTIONS_TEMPLATE_ID = "proprio.peer";

/** Default guidance for a peer connection; the connection screen edits and resets against it. */
export function proprioPeerInstructionTemplate(peer: ProprioPeer): ConnectionInstructionTemplate {
  return {
    id: PROPRIO_PEER_INSTRUCTIONS_TEMPLATE_ID,
    version: 1,
    text: [
      `These tools act on a different Proprio instance at ${peer.origin}, not the Proprio you work in.`,
      "For your own tasks, comments and documents, keep using your own Proprio tools.",
      `Use these tools only when your task asks you to send, read or update work on ${peer.host}.`,
      `Whatever you send there is visible to that instance's organization, so include only what the task asks you to share.`,
      `Task IDs and links from ${peer.host} do not exist in your own Proprio: quote the full ${peer.origin} links these tools return.`,
    ].join(" "),
  };
}

/** Standing guidance attached to a new peer connection. People can edit or turn it off. */
export function proprioPeerAgentInstructions(peer: ProprioPeer): ConnectionAgentInstructions {
  return defaultConnectionAgentInstructions(proprioPeerInstructionTemplate(peer))!;
}
