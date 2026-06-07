import type { EvidenceItem } from "./types.js";
import type { EvidenceFetcher } from "./signals.js";

/**
 * Curated evidence sources for the hero path (ROADMAP task 3.5).
 *
 * Each entry is a static feed descriptor. In the demo cycle the fetcher hits
 * these URLs, reads the first meaningful content it can parse, and returns a
 * summary for the LLM. Parsing depth is intentionally shallow: we capture the
 * page title + meta description rather than full PDF extraction so the fetcher
 * is reliable without heavy dependencies. Full document parsing (attestation
 * PDFs, PoR reports) will be wired in PR-3c with the executor.
 */

type FetchLike = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

interface FeedDescriptor {
  readonly id: string;
  readonly type: EvidenceItem["type"];
  readonly source: string;
  readonly url: string;
}

const FEEDS: FeedDescriptor[] = [
  {
    id: "ondo-usdy-attestation",
    type: "ATTESTATION",
    source: "ondo.finance",
    url: "https://ondo.finance/usdy",
  },
  {
    id: "agora-ausd-por",
    type: "ATTESTATION",
    source: "agora.finance",
    url: "https://agora.finance/ausd",
  },
];

/**
 * Sources whose scraped evidence may *satisfy the de-risk citation gate* (N2).
 *
 * Evidence summaries are pulled from external pages, so their content is
 * attacker-influenceable. To stop a hostile/un-vetted feed from fabricating an
 * item that unlocks an unwarranted LLM de-risk, only these vetted first-party RWA
 * sources can trigger a de-risk. Other scraped sources (e.g. an operator-configured
 * premium feed) can still inform the model as context — they just can't, on their
 * own, satisfy `clampVerdict`'s de-risk citation check. Derived from {@link FEEDS}
 * so the two never drift; passed into `runSignalLayer` by the executor.
 */
export const CURATED_EVIDENCE_SOURCES: ReadonlySet<string> = new Set(FEEDS.map((f) => f.source));

/**
 * Fetch a short plaintext summary from a URL by extracting the `<title>` and
 * `<meta name="description">` tags. Returns null when the page is unreachable or
 * the content is unusable.
 */
async function fetchSummary(
  url: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i);

    const title = titleMatch?.[1]?.trim() ?? "";
    const desc = descMatch?.[1]?.trim() ?? "";
    const summary = [title, desc].filter(Boolean).join(" — ");
    return summary.length > 10 ? summary : null;
  } catch {
    return null;
  }
}

/**
 * Build a production {@link EvidenceFetcher} that hits the curated USDY/AUSD
 * attestation and PoR feeds and returns parseable summaries for the LLM.
 *
 * Injectable `fetchImpl` allows tests to stub HTTP without touching the network.
 * Sources that fail or return unusable content are silently dropped — the LLM
 * will receive whatever evidence is available, and `noopEvidence` handles the
 * empty case gracefully.
 */
export function buildEvidenceFetcher(fetchImpl: FetchLike = fetch): EvidenceFetcher {
  return async (): Promise<EvidenceItem[]> => {
    const today = new Date().toISOString().slice(0, 10);

    const results = await Promise.allSettled(
      FEEDS.map(async (feed): Promise<EvidenceItem | null> => {
        const summary = await fetchSummary(feed.url, fetchImpl);
        if (!summary) return null;
        return {
          id: feed.id,
          type: feed.type,
          source: feed.source,
          url: feed.url,
          publishedAt: today,
          summary,
        };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<EvidenceItem> => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
  };
}
