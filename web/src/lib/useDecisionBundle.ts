// Lazily fetch a decision's pinned rationale bundle (ROADMAP 4.6).
//
// The on-chain DecisionRecorded event only carries rationaleHash + decisionURI; the
// human-readable rationale and the model `confidence` live in the pinned bundle (IPFS
// or an inline data: URI). The Activity list deliberately stays light (one getLogs
// pass), so the detail modal fetches the bundle for the ONE decision the user opened
// to surface its real confidence + rationale.
//
// We intentionally read only the safe primitives (confidence, rationale, riskLevel).
// The bundle's signals/evidence use the agent-side enums (ISSUER/REGULATORY/YIELD…),
// which don't match the web SignalTypeKey set — rendering them directly would crash
// SignalBadge/EvidenceChip, so those stay behind the "Decision bundle" link.

import { useEffect, useState } from "react";
import { resolveDecisionUri, decodeInlineJson, isInlineDataUri } from "./decisionUri";

export interface DecisionBundle {
  /** Model confidence (0–1), present only on LLM decisions pinned after this field shipped. */
  confidence?: number;
  rationale?: string;
  riskLevel?: string;
}

export interface BundleState {
  bundle: DecisionBundle | null;
  loading: boolean;
}

/** Fetch + parse the rationale bundle at `uri`; null while loading / on any failure. */
export function useDecisionBundle(uri: string | undefined): BundleState {
  const [bundle, setBundle] = useState<DecisionBundle | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Inline data: URI (fork/no-IPFS demo) decodes synchronously — no network.
    if (isInlineDataUri(uri)) {
      setBundle(decodeInlineJson<DecisionBundle>(uri));
      setLoading(false);
      return;
    }
    const url = resolveDecisionUri(uri);
    if (!url) {
      setBundle(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<DecisionBundle>) : null))
      .then((j) => { if (!cancelled) setBundle(j); })
      .catch(() => { if (!cancelled) setBundle(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [uri]);

  return { bundle, loading };
}
