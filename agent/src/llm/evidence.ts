import type { EvidenceItem } from "./types.js";
import type { EvidenceFetcher } from "./signals.js";
import { ONDO_USDY_ATTESTATION_FOLDER_URL, type AttestationFacts } from "../data/attestations.js";

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

export interface EvidenceFetcherOptions {
  /**
   * Demo-only override (docs/demo.md): swaps the curated `ondo-usdy-attestation`
   * feed's URL for a staged document hosting a concrete, cited USDY threat, so the
   * LLM-driven de-risk can be demonstrated on camera. `id`, `type`, and `source`
   * are kept unchanged — so the staged item still resolves to a trusted source and
   * stays de-risk-eligible under N2. Unset = production behaviour, untouched.
   */
  readonly demoEvidenceUrl?: string | undefined;
  /**
   * Provider for the latest parsed Ondo USDY reserve attestation (Dropbox-backed).
   * When set and NOT in demo mode, the `ondo-usdy-attestation` item is built from the
   * report's STRUCTURED facts (backing ratio, T-bill %, WAM, yield) rather than the
   * homepage scrape — the substantive evidence the LLM reasons over. Returns null on
   * any fetch/parse failure → falls back to the scrape.
   */
  readonly attestation?: (() => Promise<AttestationFacts | null>) | undefined;
}

/** A one-line evidence summary from the attestation's structured facts. */
function attestationSummary(facts: AttestationFacts): string {
  return (
    `Ondo USDY reserve attestation (Ankura Trust Co., ${facts.date}): ` +
    `${(facts.collateralRatioBps / 100).toFixed(2)}% backed (permitted assets vs token principal); ` +
    `${facts.tbillPct}% US Treasury Bills; weighted-avg maturity ${facts.wamDays}d; ` +
    `est. yield ${facts.estYieldPct}%.`
  );
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
export function buildEvidenceFetcher(
  fetchImpl: FetchLike = fetch,
  options: EvidenceFetcherOptions = {},
): EvidenceFetcher {
  // Demo override: re-point ONLY the ondo attestation feed; everything else
  // (id/type/source, all other feeds) is identical, so production is unaffected
  // when `demoEvidenceUrl` is unset.
  const feeds = options.demoEvidenceUrl
    ? FEEDS.map((f) =>
        f.id === "ondo-usdy-attestation" ? { ...f, url: options.demoEvidenceUrl as string } : f,
      )
    : FEEDS;

  return async (): Promise<EvidenceItem[]> => {
    const today = new Date().toISOString().slice(0, 10);

    const results = await Promise.allSettled(
      feeds.map(async (feed): Promise<EvidenceItem | null> => {
        // Real Ondo attestation report (when configured and not overridden for the
        // demo): build from the parsed structured facts instead of scraping.
        if (feed.id === "ondo-usdy-attestation" && options.demoEvidenceUrl === undefined && options.attestation) {
          const facts = await options.attestation().catch(() => null);
          if (facts) {
            return {
              id: feed.id,
              type: feed.type,
              source: feed.source,
              url: ONDO_USDY_ATTESTATION_FOLDER_URL,
              publishedAt: facts.date,
              summary: attestationSummary(facts),
            };
          }
          // facts === null → fall through to the homepage scrape below.
        }

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
