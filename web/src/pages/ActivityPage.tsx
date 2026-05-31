// Activity (§5.2). Matches Design/src/activity.jsx.

import { useState } from "react";
import { Icon } from "../components/Icons";
import { Card, RiskLevelChip, SignalBadge, EvidenceChip, FlagChip, OutcomeStrip, GuardrailsMark, ConfidenceMeter, AddressChip, Skeleton, EmptyState, ErrorState } from "../components/Components";
import { WeightBars } from "../components/Charts";
import { Modal } from "../modals/Modals";
import * as fmt from "../lib/fmt";
import { RISK, explorer, type Decision } from "../lib/data";
import { useDecisions } from "../lib/useGuardianData";
import { resolveDecisionUri } from "../lib/decisionUri";

const KIND: Record<number, { label: string; icon: string }> = {
  0: { label: "Rebalance", icon: "refresh-cw" },
  1: { label: "De-risk", icon: "shield" },
};

function KindBadge({ kind }: { kind: number }) {
  const k = KIND[kind] ?? KIND[0]!;
  const role = kind === 1 ? "error" : "info";
  return <span className={"chip role-" + role}><Icon name={k.icon} size={13} />{k.label}</span>;
}

function DecisionItem({ d, onOpen }: { d: Decision; onOpen: (d: Decision) => void }) {
  const r = RISK[d.riskLevel];
  return (
    <button className="decision-item" onClick={() => onOpen(d)} aria-label={`Decision ${d.id} detail`}>
      <span className="decision-rail" style={{ background: `var(--${r.role})` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <KindBadge kind={d.kind} />
          <RiskLevelChip level={d.riskLevel} showLabel={false} />
          <span style={{ fontSize: "0.8125rem", color: "var(--faint)" }} className="mono">#{d.id}</span>
          <span style={{ fontSize: "0.8125rem", color: "var(--faint)", marginLeft: "auto" }}>{fmt.timeAgo(d.timestamp)}</span>
        </div>
        <p style={{ margin: "11px 0 0", fontSize: "0.9375rem", fontWeight: 500, lineHeight: 1.45 }}>{d.summary}</p>
        <div style={{ margin: "14px 0", maxWidth: 420 }}><WeightBars pre={d.preWeightsBps} post={d.postWeightsBps} /></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {d.signals.map((s, i) => <SignalBadge key={i} type={s.type} severity={s.severity} />)}
          <ConfidenceMeter value={d.confidence} compact />
          <GuardrailsMark small />
        </div>
        <div className="decision-foot">
          <div style={{ flex: 1, minWidth: 200 }}><OutcomeStrip outcome={d.outcome} compact /></div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <a className="chip role-neutral" style={{ textDecoration: "none" }} href={`${explorer}/tx/${d.txHash}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              <Icon name="external-link" size={12} />tx
            </a>
            <span className="mono" style={{ fontSize: "0.6875rem", color: "var(--faint)" }} title={d.rationaleHash}>{fmt.shortHash(d.rationaleHash, 6, 4)}</span>
            <span className="linklike" style={{ fontSize: "0.8125rem" }}>Details <Icon name="chevron-right" size={14} /></span>
          </div>
        </div>
      </div>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="card-title" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function DecisionDetailModal({ decision: d, onClose }: { decision: Decision; onClose: () => void }) {
  const r = RISK[d.riskLevel];
  const evById = Object.fromEntries(d.evidence.map((e) => [e.id, e]));
  return (
    <Modal title={`Decision #${d.id}`} icon={KIND[d.kind]?.icon ?? "refresh-cw"} onClose={onClose} size="lg">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <KindBadge kind={d.kind} />
        <RiskLevelChip level={d.riskLevel} />
        <ConfidenceMeter value={d.confidence} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{fmt.dateTime(d.timestamp)}</span>
      </div>
      <Section title="Rationale">
        <p style={{ margin: 0, fontSize: "0.9375rem", lineHeight: 1.55 }}>{d.rationale}</p>
      </Section>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px" }}>
          <Section title="Risk verdict">
            <div style={{ padding: "12px 14px", borderRadius: "var(--rounded-btn)", background: `var(--${r.role}-soft)`, border: `1px solid color-mix(in srgb, var(--${r.role}) 25%, transparent)` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="dot" style={{ background: `var(--${r.role})` }} />
                <strong style={{ color: `var(--${r.role})` }}>{r.status}</strong>
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 6 }}>{r.means}. Confidence {d.confidence.toFixed(2)}.</div>
            </div>
          </Section>
        </div>
        <div style={{ flex: "1 1 240px" }}>
          <Section title="Deterministic flags (pre-LLM)">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{d.flags.map((fl) => <FlagChip key={fl} flag={fl} />)}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: 8 }}>Fired by the rule-based risk engine — not the model's opinion.</div>
          </Section>
        </div>
      </div>
      <Section title="Allocation — before → after">
        <div style={{ maxWidth: 460, marginBottom: 8 }}><WeightBars pre={d.preWeightsBps} post={d.postWeightsBps} /></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <GuardrailsMark small />
          <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>Ceiling in force: max USDY <span className="mono">{fmt.bpsToWeight(d.maxUsdyWeightBpsAllowed)}%</span></span>
        </div>
      </Section>
      <Section title="Signals & evidence">
        <div className="grid" style={{ gap: 10 }}>
          {d.signals.map((s, i) => {
            const ev = s.evidenceId ? evById[s.evidenceId] : undefined;
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: "var(--rounded-btn)", padding: "12px 14px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <SignalBadge type={s.type} severity={s.severity} />
                  <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>{s.summary}</span>
                </div>
                {ev && (
                  <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--faint)" }}>Evidence:</span>
                    <EvidenceChip ev={ev} />
                    <span style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{ev.summary}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="Outcome">
        <div style={{ padding: "14px 16px", borderRadius: "var(--rounded-btn)", background: "var(--base-200)" }}>
          <OutcomeStrip outcome={d.outcome} />
          {d.outcome?.measuredAt && <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: 10 }}>Measured {fmt.dateTime(d.outcome.measuredAt)}</div>}
        </div>
      </Section>
      <Section title="Verifiability">
        <div className="kvrow"><span className="k">Transaction</span><AddressChip address={d.txHash} kind="tx" /></div>
        <div className="kvrow"><span className="k">Rationale hash</span><span className="mono v" style={{ fontSize: "0.8125rem" }}>{fmt.shortHash(d.rationaleHash, 10, 6)}</span></div>
        {d.evidenceHash && <div className="kvrow"><span className="k">Evidence hash</span><span className="mono v" style={{ fontSize: "0.8125rem" }}>{fmt.shortHash(d.evidenceHash, 6, 4)}</span></div>}
        <div className="kvrow"><span className="k">Decision bundle</span>{(() => {
          const href = resolveDecisionUri(d.decisionURI);
          const label = <>{fmt.shortHash(d.decisionURI, 14, 6)} <Icon name="external-link" size={13} /></>;
          return href
            ? <a className="linklike mono" style={{ fontSize: "0.8125rem" }} href={href} target="_blank" rel="noreferrer">{label}</a>
            : <span className="mono v" style={{ fontSize: "0.8125rem" }}>{fmt.shortHash(d.decisionURI, 14, 6)}</span>;
        })()}</div>
      </Section>
    </Modal>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "derisk", label: "De-risk only" },
  { id: "rebalance", label: "Rebalance" },
];

interface ActivityPageProps { loading: boolean; activityError: boolean; }

export function ActivityPage({ loading, activityError }: ActivityPageProps) {
  const [filter, setFilter] = useState("all");
  const [risk, setRisk] = useState("all");
  const [openDecision, setOpenDecision] = useState<Decision | null>(null);

  const { decisions } = useDecisions();
  let list = decisions;
  if (filter === "derisk") list = list.filter((d) => d.kind === 1);
  else if (filter === "rebalance") list = list.filter((d) => d.kind === 0);
  if (risk !== "all") list = list.filter((d) => d.riskLevel === risk);

  return (
    <div className="page">
      {openDecision && <DecisionDetailModal decision={openDecision} onClose={() => setOpenDecision(null)} />}
      <div className="page-head">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">The transparent, on-chain decision log. Every action carries plain-language reasoning, the evidence behind it, and a measured outcome.</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18, alignItems: "center" }}>
        <div className="seg">
          {FILTERS.map((ff) => <button key={ff.id} className={filter === ff.id ? "on" : ""} onClick={() => setFilter(ff.id)}>{ff.label}</button>)}
        </div>
        <span style={{ width: 1, height: 24, background: "var(--border)", margin: "0 2px" }} />
        <div className="seg">
          {["all", "NORMAL", "CAUTION", "DERISK"].map((rk) => (
            <button key={rk} className={risk === rk ? "on" : ""} onClick={() => setRisk(rk)}>
              {rk === "all" ? "Any risk" : rk[0] + rk.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="grid" style={{ gap: 12 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={190} r={14} />)}</div>
      ) : activityError ? (
        <Card><ErrorState title="Couldn't load decisions" body="The agent history couldn't be fetched. Check your connection and try again." /></Card>
      ) : list.length === 0 ? (
        <Card><EmptyState icon="scroll-text" title="No decisions match" body="No decisions yet for this filter — the agent is monitoring." action={<button className="btn btn-ghost btn-sm" onClick={() => { setFilter("all"); setRisk("all"); }}>Clear filters</button>} /></Card>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {list.map((d) => <DecisionItem key={d.id} d={d} onOpen={setOpenDecision} />)}
        </div>
      )}
    </div>
  );
}
