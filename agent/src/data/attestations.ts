import { extractText, getDocumentProxy } from "unpdf";

/**
 * Deterministic parser for the daily Ondo USDY reserve attestation (the "ATC"
 * report verified by Ankura Trust Company). The agent turns this unstructured PDF
 * into structured reserve facts the LLM and the risk engine can reason over — the
 * genuine unstructured→structured RWA path (CLAUDE.md #3).
 *
 * The NUMBERS are extracted deterministically (regex over the report's labelled
 * lines); they are never LLM-guessed. The LLM's job is judgment over the narrative
 * (exceptions, novel disclosures), not arithmetic. See docs/agents.md §2.1.
 *
 * Parsing is layout-tolerant: unpdf flattens the report to linear text where each
 * label is immediately followed by its value, and the summary T-bill row uniquely
 * says "US Treasury Bills" (the CUSIP ladder says "US Treasuries"), so anchors don't
 * collide.
 */

export interface AttestationFacts {
  /** Report "end of day" date, ISO (e.g. "2026-06-09"). */
  readonly date: string;
  /** Token principal outstanding (USD). */
  readonly tokenPrincipalOutstanding: number;
  /** Permitted assets at market value (USD) — the reserves backing the tokens. */
  readonly permittedAssetsMarketValue: number;
  /** Reserves / token principal, in bps (10_000 = exactly 100% backed). */
  readonly collateralRatioBps: number;
  /** US Treasury Bills as a percent of permitted assets (e.g. 99.86). */
  readonly tbillPct: number;
  /** Weighted-average maturity of permitted assets, in days. */
  readonly wamDays: number;
  /** Estimated blended yield of permitted assets, percent (e.g. 3.61). */
  readonly estYieldPct: number;
}

/** Extract the report's flat text from raw PDF bytes (pure-JS; no native deps). */
export async function extractAttestationText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** Parse a US number with thousands separators ("2,139,527,002.70") → 2139527002.7. */
function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** First capture group of `re` against `text`, or undefined. */
function cap(re: RegExp, text: string): string | undefined {
  return re.exec(text)?.[1];
}

/** "6/9/2026" → "2026-06-09". Returns null on an unrecognized shape. */
function toIsoDate(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

/**
 * Parse the structured facts from the attestation's flat text. Returns null if any
 * required field is missing or malformed — callers degrade to "no attestation
 * evidence this cycle" rather than acting on a half-parsed report.
 */
export function parseAttestationFacts(text: string): AttestationFacts | null {
  const date = toIsoDate(cap(/Date\s*\(end of day\)\s*([\d/]+)/i, text));
  const tokenPrincipal = num(cap(/Token Principal Outstanding\s+([\d,]+\.\d+)/i, text));
  const permittedAssets = num(cap(/Permitted Assets \(at market value\)\s+([\d,]+\.\d+)/i, text));
  const wamDays = num(cap(/Weighted Average Maturity of Permitted Assets \(Days\)\s+([\d,]+\.\d+)/i, text));
  // Summary row: "US Treasury Bills <marketValue> <wam> <pct>% <yield>%".
  const tbillRow = /US Treasury Bills\s+[\d,]+\.\d+\s+[\d,]+\.\d+\s+([\d.]+)%\s+([\d.]+)%/i.exec(text);
  const tbillPct = num(tbillRow?.[1]);
  const estYieldPct = num(tbillRow?.[2]);

  if (
    date === null ||
    tokenPrincipal === null ||
    permittedAssets === null ||
    wamDays === null ||
    tbillPct === null ||
    estYieldPct === null ||
    tokenPrincipal <= 0
  ) {
    return null;
  }

  // Compute the backing ratio from the two reported totals (cross-checkable and more
  // precise than the rounded "Permitted Assets/Token Principal Outstanding" line).
  const collateralRatioBps = Math.round((permittedAssets / tokenPrincipal) * 10_000);

  return {
    date,
    tokenPrincipalOutstanding: tokenPrincipal,
    permittedAssetsMarketValue: permittedAssets,
    collateralRatioBps,
    tbillPct,
    wamDays,
    estYieldPct,
  };
}

/** Convenience: extract + parse in one call. Returns null on unreadable/unparseable input. */
export async function readAttestation(bytes: Uint8Array): Promise<AttestationFacts | null> {
  let text: string;
  try {
    text = await extractAttestationText(bytes);
  } catch {
    return null;
  }
  return parseAttestationFacts(text);
}
