import { extractText, getDocumentProxy } from "unpdf";
import { USDY_MIN_COLLATERAL_BPS } from "@custos/shared";

import type { DropboxReader } from "./dropbox.js";

/**
 * The public Dropbox shared folder of daily Ondo USDY attestation PDFs, structured
 * `<year>/<MM Month>/Ondo USDY LLC_ATCAttest_YYMMDD.pdf`. Stable; override only if
 * Ondo re-publishes the link.
 */
export const ONDO_USDY_ATTESTATION_FOLDER_URL =
  "https://www.dropbox.com/scl/fo/375wdvar3rbc7o23nxsgp/AOFY8jhpENaNx9WAw-WPnbY?rlkey=4icqn1z9bez725wywr30fx52a";

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

/**
 * Deterministic issuer backstop: the reserves no longer fully back the tokens
 * (backing ratio below the {@link USDY_MIN_COLLATERAL_BPS} floor). When true the
 * agent forces USDY -> 0 regardless of the LLM (tighten-only; the model can't loosen
 * it). A clean report (ratio >= floor) is no-signal.
 */
export function isAttestationBreach(facts: AttestationFacts): boolean {
  return facts.collateralRatioBps < USDY_MIN_COLLATERAL_BPS;
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

/** Highest-sorting folder name matching `re` (entries are folders only). */
function latestFolder(entries: { tag: "file" | "folder"; name: string }[], re: RegExp): string | undefined {
  return entries
    .filter((e) => e.tag === "folder" && re.test(e.name))
    .map((e) => e.name)
    .sort()
    .at(-1);
}

/**
 * Find, download, and parse the LATEST Ondo USDY attestation from the Dropbox shared
 * folder. Walks `<year>/<MM Month>/…_ATCAttest_YYMMDD.pdf`, picking the newest at each
 * level (folder names are zero-padded so a lexical sort is chronological; files are
 * picked by their YYMMDD stamp). Fail-soft: returns null on any listing/download/parse
 * error so a bad cycle degrades to "no attestation evidence", never throws.
 *
 * (The monthly folders hold ≤31 files, well under Dropbox's list page size, so no
 * pagination is needed.)
 */
export async function fetchLatestAttestation(
  reader: DropboxReader,
  folderUrl: string = ONDO_USDY_ATTESTATION_FOLDER_URL,
): Promise<AttestationFacts | null> {
  try {
    const root = await reader.listSharedFolder(folderUrl, "");
    const year = latestFolder(root, /^\d{4}$/);
    if (year === undefined) return null;

    const months = await reader.listSharedFolder(folderUrl, `/${year}`);
    const month = latestFolder(months, /^\d{2}\b/); // "06 June", "12 December", …
    if (month === undefined) return null;

    const files = await reader.listSharedFolder(folderUrl, `/${year}/${month}`);
    const latest = files
      .filter((e) => e.tag === "file" && /ATCAttest_\d{6}\.pdf$/i.test(e.name))
      .map((e) => ({ name: e.name, stamp: /ATCAttest_(\d{6})\.pdf$/i.exec(e.name)![1]! }))
      .sort((a, b) => a.stamp.localeCompare(b.stamp))
      .at(-1);
    if (latest === undefined) return null;

    const bytes = await reader.downloadSharedFile(folderUrl, `/${year}/${month}/${latest.name}`);
    return await readAttestation(bytes);
  } catch {
    return null;
  }
}
