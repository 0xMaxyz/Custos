/**
 * RPC endpoint rotation for the agent (resilience against a single rate-limited
 * provider). The agent makes a steady stream of reads (snapshots, multicalls,
 * receipt polling); a lone public RPC returns 429 under that load. We compose an
 * ordered, deduped URL list that `chain/clients.ts` turns into a viem `fallback`
 * transport:
 *
 *   1. PREMIUM_MANTLE_RPC first (paid/goldsky) — handles all traffic while healthy.
 *   2. then a shuffled merge of the live community list + static MANTLE_RPC_URL(s),
 *      so when the premium endpoint errors viem walks down to a *random* public
 *      one (the shuffle spreads load across restarts) and advances again on the
 *      next 429 rather than hammering one endpoint.
 *
 * The community list comes from the 1delta rpc-tester repo, refreshed twice a day
 * to only contain endpoints seen working in the last ~6h. We fetch it at startup
 * with a short timeout and fall back to a pinned snapshot if the fetch fails, so a
 * GitHub outage can never stop the agent from booting.
 */

/** Raw 1delta rpc-tester list for Mantle (chainId 5000), refreshed ~twice daily. */
export const RPC_LIST_URL =
  "https://raw.githubusercontent.com/1delta-DAO/rpc-tester/main/rpcs/5000.json";

/**
 * Pinned snapshot of known-good public Mantle RPCs, used only when the live fetch
 * fails. Keep this list short and conservative — it is a last resort, not the
 * primary source.
 */
export const FALLBACK_RPCS: readonly string[] = [
  "https://rpc.mantle.xyz",
  "https://mantle-rpc.publicnode.com",
  "https://mantle.drpc.org",
];

/** Shape of the 5000.json document (only the fields we read). */
interface RpcListDoc {
  chainId?: number;
  rpcs?: { url?: unknown }[];
}

/** Normalize a URL for dedupe (trim, drop a single trailing slash). Lower-cases host only via URL. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Keep only well-formed http(s) URLs. */
function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Fisher–Yates shuffle returning a new array (does not mutate the input). */
function shuffleArray<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export interface FetchRpcListOptions {
  /** Injected fetch (defaults to global `fetch`) — lets tests stub the network. */
  fetchFn?: typeof fetch;
  /** Abort the request after this many ms (default 4000). */
  timeoutMs?: number;
}

/**
 * Fetch the live community RPC list. Returns the parsed `rpcs[].url` (http(s)
 * only). On ANY failure (network, timeout, bad JSON, empty) returns
 * {@link FALLBACK_RPCS} so callers always get a usable list. Never throws.
 */
export async function fetchMantleRpcList(opts: FetchRpcListOptions = {}): Promise<string[]> {
  const { fetchFn = fetch, timeoutMs = 4000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(RPC_LIST_URL, { signal: controller.signal });
    if (!res.ok) return [...FALLBACK_RPCS];
    const doc = (await res.json()) as RpcListDoc;
    const urls = (doc.rpcs ?? [])
      .map((r) => (typeof r.url === "string" ? r.url : ""))
      .filter((u) => u && isHttpUrl(u));
    return urls.length > 0 ? urls : [...FALLBACK_RPCS];
  } catch {
    return [...FALLBACK_RPCS];
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolveRpcUrlsArgs {
  /** Premium endpoint, pinned first when present (PREMIUM_MANTLE_RPC). */
  premium?: string | undefined;
  /** The live/community list (from {@link fetchMantleRpcList}). */
  fetched?: readonly string[] | undefined;
  /** Operator-configured static URL(s) (MANTLE_RPC_URL, comma-split). */
  staticUrls?: readonly string[] | undefined;
  /** Shuffle implementation — overridable for deterministic tests. */
  shuffle?: (<T>(items: readonly T[]) => T[]) | undefined;
}

/**
 * Compose the final ordered, deduped RPC URL list: premium first, then a shuffled
 * merge of the community + static lists. Invalid/non-http URLs are dropped.
 */
export function resolveRpcUrls(args: ResolveRpcUrlsArgs): string[] {
  const { premium, fetched = [], staticUrls = [], shuffle = (a) => shuffleArray(a) } = args;

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const url = raw.trim();
    if (!isHttpUrl(url)) return;
    const key = normalize(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };

  add(premium);
  // Shuffle the public pool so different runs enter the fallback chain at different
  // endpoints — spreading load instead of always hammering the same first one.
  for (const url of shuffle([...fetched, ...staticUrls])) add(url);

  return out;
}

export interface ResolveMantleRpcUrlsConfig {
  premiumMantleRpc?: string | undefined;
  /** Comma-separated static MANTLE_RPC_URL value. */
  mantleRpcUrl: string;
}

/**
 * Startup convenience: fetch the live list and compose the full ordered URL set
 * for {@link ResolveMantleRpcUrlsConfig}. Always returns at least one URL (the
 * static config is the floor), so the agent can always build a transport.
 */
export async function resolveMantleRpcUrls(
  config: ResolveMantleRpcUrlsConfig,
  opts: FetchRpcListOptions = {},
): Promise<string[]> {
  const fetched = await fetchMantleRpcList(opts);
  const staticUrls = config.mantleRpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const urls = resolveRpcUrls({ premium: config.premiumMantleRpc, fetched, staticUrls });
  // Guarantee a non-empty result even in the pathological case where everything
  // was filtered out — fall back to the static config as-is.
  return urls.length > 0 ? urls : staticUrls;
}
