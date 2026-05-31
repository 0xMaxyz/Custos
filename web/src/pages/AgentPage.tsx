// Agent (§5.3). Matches Design/src/agent.jsx.

import { useState, useRef, useEffect } from "react";
import { Icon } from "../components/Icons";
import { Card, AddressChip, StatusDot, Skeleton } from "../components/Components";
import * as fmt from "../lib/fmt";
import { RISK, SIGNAL_TYPES, watchlist, guardrails, askSuggestions, askAnswers } from "../lib/data";
import { useIdentity } from "../lib/useGuardianData";

function IdentityCard() {
  const { identity: id } = useIdentity();
  const tr = id.trackRecord;
  return (
    <Card>
      <span className="card-title"><Icon name="fingerprint" size={14} />Agent identity · ERC-8004</span>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="agent-nft" aria-hidden="true">
          <Icon name="shield-check" size={34} />
          <span className="mono" style={{ fontSize: "0.6875rem", marginTop: 6, opacity: 0.85 }}>#{id.agentId}</span>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{id.name}</div>
          <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 2 }}>Agent ID <span className="mono">#{id.agentId}</span></div>
          <div style={{ marginTop: 12, display: "grid", gap: 2 }}>
            <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">Owner</span><AddressChip address={id.owner} /></div>
            <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">Registry</span><AddressChip address={id.identityRegistry} /></div>
            <div className="kvrow" style={{ padding: "5px 0" }}><span className="k">Agent card</span><a className="linklike mono" style={{ fontSize: "0.8125rem" }} href="#" onClick={(e) => e.preventDefault()}>{fmt.shortHash(id.agentURI, 12, 6)} <Icon name="external-link" size={13} /></a></div>
          </div>
        </div>
      </div>
      <hr className="divider" />
      <div className="grid track" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {[
          { l: "Decisions", v: tr.decisions },
          { l: "De-risk events", v: tr.deRiskEvents },
          { l: "vs passive", v: "+" + tr.realizedVsPassivePct + "%", role: "success" },
          { l: "Drawdown avoided", v: "−" + fmt.usd(tr.drawdownAvoidedUsdc, { cents: false }), role: "success" },
        ].map((s, i) => (
          <div key={i}>
            <div className="mono" style={{ fontWeight: 700, fontSize: "1.25rem", color: s.role ? `var(--${s.role})` : undefined }}>{s.v}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function WatchlistPanel() {
  return (
    <Card>
      <span className="card-title"><Icon name="eye" size={14} />What I'm watching</span>
      <div style={{ display: "grid", gap: 2 }}>
        {watchlist.map((w, i) => {
          const r = RISK[w.status];
          const t = SIGNAL_TYPES[w.signal];
          return (
            <div key={i} className="watch-row">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9, flex: "1 1 auto", minWidth: 0 }}>
                <Icon name={t.icon} size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{w.label}</span>
              </span>
              <span className="mono" style={{ fontSize: "0.8125rem", textAlign: "right" }}>{w.value}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 86, justifyContent: "flex-end" }}>
                <StatusDot role={r.role} />
                <span style={{ fontSize: "0.75rem", color: `var(--${r.role})`, fontWeight: 600 }}>{w.status === "NORMAL" ? "Normal" : w.status === "CAUTION" ? "Caution" : "De-risk"}</span>
              </span>
              {w.threshold !== "—" && <span className="watch-thresh">{w.threshold}</span>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function GuardrailsPanel() {
  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="lock" size={14} />The limits · on-chain guardrails</span>
        <span className="chip role-success" style={{ height: 22 }}><Icon name="shield-check" size={12} />Immutable</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "0.875rem", color: "var(--muted)", lineHeight: 1.5 }}>
        The agent proposes; these bounds dispose. The model can never cross them — it is never the last line of defense.
      </p>
      <div className="guardrail-grid">
        {guardrails.map((g) => (
          <div key={g.key} className="guardrail">
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{g.label}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: "1rem", marginTop: 3 }}>{g.value}</div>
            <div className="mono" style={{ fontSize: "0.6875rem", color: "var(--faint)", marginTop: 2 }}>{g.field}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

interface Msg { role: "user" | "agent"; text: string; }

function AskPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs, typing]);

  const ask = (q: string) => {
    if (typing) return;
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      const a = askAnswers[q] ?? "I answer from decision history and the current snapshot. Try one of the suggested questions — I explain, but I never take orders or execute trades from chat.";
      setMsgs((m) => [...m, { role: "agent", text: a }]);
    }, 900);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) { ask(input.trim()); setInput(""); }
  };

  return (
    <Card pad={false} className="ask-card">
      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
        <span className="brand-mark" style={{ width: 30, height: 30, background: "var(--primary-soft)", color: "var(--primary)" }}><Icon name="sparkles" size={16} /></span>
        <div>
          <div style={{ fontWeight: 600 }}>Ask the agent</div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Explains its reasoning · read-only, never executes</div>
        </div>
      </div>
      <div className="ask-body" ref={scroller}>
        {msgs.length === 0 && !typing && (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: "24px 8px" }}>
            <Icon name="message-circle" size={26} style={{ opacity: 0.5 }} />
            <div style={{ fontSize: "0.875rem", marginTop: 8 }}>Ask about a decision or the current stance.</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={"bubble " + m.role}>{m.text}</div>
        ))}
        {typing && <div className="bubble agent typing"><span /><span /><span /></div>}
      </div>
      <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
          {askSuggestions.map((q) => (
            <button key={q} className="chip role-neutral" style={{ cursor: "pointer", height: 26 }} onClick={() => ask(q)} disabled={typing}>{q}</button>
          ))}
        </div>
        <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} disabled={typing} placeholder="Ask why, what changed, what's watched…"
            aria-label="Ask the agent" style={{ flex: 1, height: 40, border: "1px solid var(--border-strong)", borderRadius: "var(--rounded-btn)", padding: "0 13px", background: "var(--base-100)", color: "var(--base-content)", fontSize: "0.875rem", fontFamily: "inherit", outline: "none" }} />
          <button className="btn btn-primary" type="submit" disabled={typing || !input.trim()} aria-label="Send"><Icon name="send" size={16} /></button>
        </form>
        <div style={{ fontSize: "0.6875rem", color: "var(--faint)", marginTop: 8, display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="info" size={12} />Explanations only. The agent acts solely within on-chain guardrails — it never takes orders from chat.
        </div>
      </div>
    </Card>
  );
}

export function AgentPage({ loading }: { loading: boolean }) {
  if (loading) {
    return <div className="page"><div className="grid agent-cols"><div className="grid" style={{ gap: 16 }}><Skeleton h={220} r={14} /><Skeleton h={260} r={14} /></div><Skeleton h={420} r={14} /></div></div>;
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agent</h1>
          <p className="page-sub">A tangible, verifiable autonomous agent: its on-chain identity, what it watches in real time, the limits it can never cross, and a bounded way to ask why.</p>
        </div>
      </div>
      <div className="grid agent-cols">
        <div className="grid" style={{ gap: 16, alignContent: "start" }}>
          <IdentityCard />
          <WatchlistPanel />
          <GuardrailsPanel />
        </div>
        <AskPanel />
      </div>
    </div>
  );
}
