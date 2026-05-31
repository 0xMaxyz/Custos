// Decision URI resolution (ROADMAP 4.6).
//
// Each on-chain decision stores a `decisionURI` pointing at the rationale +
// evidence bundle the agent pinned (ipfs:// or, on a local/fork demo, a data:
// URI). The risk-guardian feed's detail view resolves that URI to a fetchable
// HTTPS URL (via an IPFS gateway) or decodes the inline data URI. Pure + tested
// so the feed component owns only rendering.

/** Default public IPFS gateway. Overridable via VITE_IPFS_GATEWAY_URL. */
export const DEFAULT_IPFS_GATEWAY = "https://gateway.pinata.cloud";

function gatewayBase(): string {
  const env = (import.meta.env?.VITE_IPFS_GATEWAY_URL as string | undefined) ?? "";
  return (env || DEFAULT_IPFS_GATEWAY).replace(/\/$/, "");
}

/**
 * Turn a `decisionURI` into something the browser can open/fetch:
 *   - ipfs://<cid>[/path]  → `<gateway>/ipfs/<cid>[/path]`
 *   - data:...             → returned unchanged (already inline-resolvable)
 *   - http(s)://...        → returned unchanged
 * Returns null for an empty/garbage URI so callers can hide the link.
 */
export function resolveDecisionUri(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (path === "") return null;
    return `${gatewayBase()}/ipfs/${path}`;
  }
  if (trimmed.startsWith("data:") || /^https?:\/\//.test(trimmed)) return trimmed;
  return null;
}

/** True when the URI is an inline data: URI (no network fetch needed). */
export function isInlineDataUri(uri: string | undefined | null): boolean {
  return typeof uri === "string" && uri.trim().startsWith("data:");
}

/**
 * Decode an inline `data:application/json;base64,...` URI to its parsed object.
 * Returns null when the URI is not a decodable inline JSON data URI. Used so the
 * fork/demo path can show the rationale bundle without any network call.
 */
export function decodeInlineJson<T = unknown>(uri: string | undefined | null): T | null {
  if (!isInlineDataUri(uri)) return null;
  const comma = uri!.indexOf(",");
  if (comma < 0) return null;
  const meta = uri!.slice(5, comma); // between "data:" and ","
  const payload = uri!.slice(comma + 1);
  try {
    const json = meta.includes("base64") ? atob(payload) : decodeURIComponent(payload);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
