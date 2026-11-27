import { createPrivateKey, createSign } from "node:crypto";
import { forbidden, unprocessable } from "../errors.js";

export function githubAppJwt(
  appId: string,
  privateKey: string,
  now = new Date(),
): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

/** Bound requests to GitHub, with no redirects or credential-bearing errors. */
export async function requestGitHubApp<T>(
  fetchImpl: typeof fetch,
  token: string | null,
  path: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
  { timeoutMs = 15_000, classifyError }: {
    timeoutMs?: number;
    classifyError?: (response: Response, secondaryRateLimit: boolean) => Record<string, unknown>;
  } = {},
): Promise<T> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  )
    throw forbidden("Invalid GitHub operation path");
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw unprocessable(
      "GitHub is temporarily unavailable. Retry this operation.",
      { code: "github_bot_temporarily_unavailable", retryable: true },
    );
  }
  if (!response.ok) {
    let secondaryRateLimit = false;
    if (classifyError && response.status === 403) {
      const reader = response.body?.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8192) break;
          chunks.push(part.value);
        }
        secondaryRateLimit = /secondary rate limit|rate limit exceeded|abuse detection/i.test(Buffer.concat(chunks).toString("utf8"));
      } catch {
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
    await response.body?.cancel();
    throw unprocessable(
      `GitHub rejected this operation (HTTP ${response.status}).`,
      classifyError?.(response, secondaryRateLimit),
    );
  }
  if (response.status === 204) return undefined as T;
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("GitHub returned an empty response", { code: "github_bot_invalid_response", retryable: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw unprocessable(
          "GitHub response exceeds the review limit. Narrow the request or report incomplete coverage.",
        );
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return (options.accept?.includes("diff") ? body : JSON.parse(body)) as T;
    } catch {
      throw unprocessable("GitHub returned an invalid response", { code: "github_bot_invalid_response", retryable: true });
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw unprocessable("GitHub response was interrupted. Retry this operation.", { code: "github_bot_temporarily_unavailable", retryable: true });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
