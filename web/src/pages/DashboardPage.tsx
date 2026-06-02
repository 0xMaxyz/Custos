// Dashboard (§5.1). Matches Design/src/dashboard.jsx.

import { useState } from "react";
import { useAccount } from "wagmi";
import { Icon } from "../components/Icons";
import { Card, Skeleton, EmptyState, InfoTip, ConfidenceMeter, SignalBadge, RwaFormSplit } from "../components/Components";
import { AllocationChart, AllocationLegend, Sparkline, PegGauge } from "../components/Charts";
import * as fmt from "../lib/fmt";
import { RISK, rwaCore } from "../lib/data";
import { useVaultData } from "../lib/useVaultData";
import { useDecisions } from "../lib/useGuardianData";
import { useInsightsData } from "../lib/useInsightsData";
import { mergeSnapshotIntoVault } from "../lib/vaultMetrics";
import { computeBaseline, formatDeltaPct } from "../lib/baseline";
import type { PositionState, VaultState } from "../lib/data";
import type { VaultData } from "../lib/useVaultData";
import type { Route } from "../components/Shell";

function AgentStatusCard({ go }: { go: (r: Route) => void }) {
  const { decisions } = useDecisions();
  const decision = decisions[0];
  if (!decision) return (
    <Card className="agent-status">
      <span className="card-title"><Icon name="shield-check" size={14} />Agent status</span>
      <p style={{ color: "var(--muted)", margin: "10px 0 0", fontSize: "0.9375rem" }}>No decisions recorded yet — the agent is monitoring.</p>
    </Card>
  );
  const r = RISK[decision.riskLevel];
  return (
    <Card className="agent-status" style={{ borderColor: `color-mix(in srgb, var(--${r.role}) 35%, var(--border))` }}>
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className="card-title" style={{ margin: 0 }}><Icon name="shield-check" size={14} />Agent status</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="dot dot-pulse" style={{ width: 12, height: 12, background: `var(--${r.role})`, boxShadow: `0 0 0 4px color-mix(in srgb, var(--${r.role}) 18%, transparent)` }} />
            <span style={{ fontSize: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em", color: `var(--${r.role})` }}>{r.status}</span>
          </div>
          <p style={{ color: "var(--muted)", margin: "10px 0 0", fontSize: "0.9375rem", maxWidth: "46ch" }}>{r.means}.</p>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--faint)" }}>Last action {fmt.timeAgo(decision.timestamp)} · #{decision.id}</span>
            <button className="linklike" style={{ background: "none", border: 0, fontSize: "0.875rem" }} onClick={() => go("activity")}>
              View reasoning <Icon name="arrow-right" size={14} />
            </button>
          </div>
        </div>
        <div style={{ flex: "1 1 240px", borderLeft: "1px solid var(--border)", paddingLeft: 18, minWidth: 220 }} className="agent-status-side">
          <div className="stat-label" style={{ marginBottom: 8 }}>Latest decision</div>
          <p style={{ margin: "0 0 12px", fontSize: "0.9375rem", fontWeight: 500, lineHeight: 1.45 }}>{decision.summary}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {decision.signals.slice(0, 2).map((s, i) => <SignalBadge key={i} type={s.type} severity={s.severity} />)}
            <ConfidenceMeter value={decision.confidence} compact />
          </div>
        </div>
      </div>
    </Card>
  );
}

function BaselineCounter({ baseline: b }: { baseline: VaultData["baseline"] }) {
  // Derive the headline delta from the benchmark series via the shared, tested
  // helper (ROADMAP 4.7) so the widget, useIdentity().baseline, and the unit tests
  // all read one source — not the raw, potentially-stale passiveDeltaBps field.
  const summary = computeBaseline(b);
  return (
    <Card className="baseline">
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="trending-up" size={14} />Custos vs passive USDY holder</span>
        <InfoTip text="Performance versus a 100% USDY buy-and-hold, since the last benchmark, from the on-chain AgentBenchmark." />
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em", color: summary.custosAhead ? "var(--success)" : "var(--error)", lineHeight: 1 }}>{formatDeltaPct(summary.deltaBps)}</span>
            <span style={{ color: "var(--muted)", fontSize: "0.9375rem" }}>vs passive</span>
          </div>
          <div style={{ display: "flex", gap: 22, marginTop: 14, flexWrap: "wrap" }}>
            <div>
              <div className="mono" style={{ fontWeight: 600, fontSize: "1.0625rem", color: "var(--success)" }}>−{fmt.usd(b.drawdownAvoidedUsdc)}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>drawdown avoided</div>
            </div>
            <div>
              <div className="mono" style={{ fontWeight: 600, fontSize: "1.0625rem" }}>{fmt.pctSigned(b.realizedYieldBps)}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>realized yield</div>
            </div>
            <div>
              <div className="mono" style={{ fontWeight: 600, fontSize: "1.0625rem" }}>#{b.sinceDecisionId}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>since decision</div>
            </div>
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <Sparkline a={b.custosSeries} b={b.passiveSeries} width={150} height={56} />
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 6, fontSize: "0.6875rem", color: "var(--muted)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 2, background: "var(--primary)" }} />Custos</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 2, background: "var(--faint)" }} />Passive</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function PositionCard({ connected, empty, paused, killed, vault, position, metricsUnavailable, onDeposit, onWithdraw, onConnect }: {
  connected: boolean; empty: boolean; paused: boolean; killed: boolean;
  vault: VaultState; position: PositionState; metricsUnavailable: boolean;
  onDeposit: () => void; onWithdraw: () => void; onConnect: () => void;
}) {
  if (!connected) {
    return (
      <Card>
        <span className="card-title"><Icon name="wallet" size={14} />Your position</span>
        <EmptyState icon="wallet" title="Connect to deposit"
          body="Connect a wallet to deposit USDC and let the agent manage your risk-adjusted yield."
          action={<button className="btn btn-primary" onClick={onConnect}><Icon name="wallet" size={16} />Connect wallet</button>} />
      </Card>
    );
  }
  if (empty) {
    return (
      <Card>
        <span className="card-title"><Icon name="coins" size={14} />Your position</span>
        <EmptyState icon="plus" title="Make your first deposit"
          body="You haven't deposited yet. Deposit USDC to start earning the agent-managed blended yield."
          action={<button className="btn btn-primary" disabled={paused || killed} onClick={onDeposit}><Icon name="plus" size={16} />Deposit USDC</button>} />
      </Card>
    );
  }
  const yld = parseFloat(position.allTimeYieldUsdc);
  return (
    <Card>
      <div className="card-hl">
        <span className="card-title" style={{ margin: 0 }}><Icon name="coins" size={14} />Your position</span>
        {metricsUnavailable
          ? <span className="chip" style={{ height: 22 }} title="Live APY comes from the agent — start it (VITE_AGENT_API_URL)">blended APY —</span>
          : <span className="chip role-success" style={{ height: 22 }}>{fmt.bpsToPct(vault.blendedApyBps)} blended APY</span>}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="stat-label">Current value</div>
          <div className="mono" style={{ fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{fmt.usd(position.valueUsdc)}</div>
        </div>
        <div style={{ marginBottom: 4 }}>
          <span className="chip role-success"><Icon name="trending-up" size={13} />{fmt.usd(yld, { sign: true })} all-time</span>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <div className="kvrow"><span className="k">Deposited</span><span className="v mono">{fmt.usd(position.depositedUsdc)}</span></div>
        <div className="kvrow"><span className="k">Shares</span><span className="v mono">{fmt.num(position.shares)}</span></div>
        <div className="kvrow"><span className="k">Share price</span><span className="v mono">{fmt.price(position.sharePrice)}</span></div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button className="btn btn-primary btn-block" disabled={paused || killed} onClick={onDeposit}
          title={killed ? "Disabled — emergency withdraw-only" : paused ? "Disabled — deposits paused" : undefined}>
          <Icon name="plus" size={16} />Deposit
        </button>
        <button className="btn btn-ghost btn-block" onClick={onWithdraw}><Icon name="minus" size={16} />Withdraw</button>
      </div>
    </Card>
  );
}

function AllocationCard({ vault }: { vault: VaultState }) {
  const instant = parseFloat(vault.instantWithdrawableUsdc);
  const tvl = parseFloat(vault.tvlUsdc);
  const instantPct = Math.round((instant / tvl) * 100);
  const ok = instantPct >= 15;
  return (
    <Card>
      <span className="card-title"><Icon name="layout-dashboard" size={14} />Allocation</span>
      <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <AllocationChart weightsBps={vault.weightsBps} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
            <div>
              <div className="mono" style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{fmt.usd(tvl, { cents: false })}</div>
              <div style={{ fontSize: "0.6875rem", color: "var(--muted)" }}>TVL</div>
            </div>
          </div>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <AllocationLegend weightsBps={vault.weightsBps} tvlUsdc={vault.tvlUsdc} />
          {vault.weightsBps.USDY > 0 && <RwaFormSplit usdyUsdc={rwaCore.usdyUsdc} musdUsdc={rwaCore.musdUsdc} />}
        </div>
      </div>
      <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: "var(--rounded-btn)", background: ok ? "var(--success-soft)" : "var(--error-soft)", display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={ok ? "check-circle" : "alert-triangle"} size={16} style={{ color: ok ? "var(--success)" : "var(--error)" }} />
        <span style={{ fontSize: "0.875rem", flex: 1 }}>Instantly withdrawable <strong className="mono">{fmt.usd(instant)}</strong> ({instantPct}% of TVL)</span>
        <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>min 15% floor</span>
      </div>
    </Card>
  );
}

function VaultStatsCard({ vault, metricsUnavailable }: { vault: VaultState; metricsUnavailable: boolean }) {
  const [open, setOpen] = useState(false);
  const tvl = parseFloat(vault.tvlUsdc), cap = parseFloat(vault.tvlCapUsdc);
  const usedPct = Math.round((tvl / cap) * 100);
  return (
    <Card>
      <span className="card-title"><Icon name="gauge" size={14} />Vault stats</span>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div>
          <div className="stat-label">TVL / cap</div>
          <div className="mono" style={{ fontWeight: 600, fontSize: "1.125rem", marginTop: 4 }}>{fmt.usd(tvl, { cents: false })} <span style={{ color: "var(--faint)", fontWeight: 500 }}>/ {fmt.usd(cap, { cents: false })}</span></div>
          <div style={{ height: 6, borderRadius: 99, background: "var(--base-300)", marginTop: 8, overflow: "hidden" }}>
            <div style={{ width: usedPct + "%", height: "100%", background: "var(--primary)" }} />
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 4 }}>{usedPct}% used · {fmt.usd(cap - tvl, { cents: false })} remaining</div>
        </div>
        <div>
          <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 4 }}>Blended APY
            <button className="iconbtn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Toggle APY breakdown"><Icon name="chevron-down" size={13} style={{ transform: open ? "rotate(180deg)" : "", transition: "transform var(--dur)" }} /></button>
          </div>
          <div className="mono" style={{ fontWeight: 600, fontSize: "1.125rem", marginTop: 4, color: metricsUnavailable ? "var(--muted)" : "var(--success)" }}>{metricsUnavailable ? "—" : fmt.bpsToPct(vault.blendedApyBps)}</div>
          {open && (
            <div style={{ marginTop: 8, fontSize: "0.8125rem" }}>
              <div className="kvrow" style={{ padding: "4px 0" }}><span className="k">USDY implied APY</span><span className="v mono" style={{ fontSize: "0.8125rem" }}>{metricsUnavailable ? "—" : fmt.bpsToPct(vault.usdyImpliedApyBps)}</span></div>
              <div className="kvrow" style={{ padding: "4px 0" }}><span className="k">Aave supply APY</span><span className="v mono" style={{ fontSize: "0.8125rem" }}>{metricsUnavailable ? "—" : fmt.bpsToPct(vault.aaveUsdcSupplyApyBps)}</span></div>
              <div style={{ fontSize: "0.6875rem", color: "var(--faint)", marginTop: 4 }}>The yield spread the agent weighs.</div>
            </div>
          )}
        </div>
      </div>
      <hr className="divider" />
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div>
          <div className="stat-label" style={{ marginBottom: 8 }}>USDY peg</div>
          {metricsUnavailable
            ? <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 8 }}>Peg comparison (NAV vs DEX) comes from the agent.</div>
            : <PegGauge deviationBps={vault.pegDeviationBps} />}
        </div>
        <div>
          <div className="stat-label">Oracle status</div>
          {metricsUnavailable ? (
            <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 8 }}>—<span style={{ color: "var(--faint)" }}> · agent offline</span></div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <span className="chip role-success"><Icon name="check" size={13} />Valid</span>
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 8 }}>Range valid until <span className="mono">{fmt.dateShort(vault.oracleRangeEnd)}</span></div>
              <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: 3 }}>Range-based oracle — not a staleness clock.</div>
            </>
          )}
        </div>
      </div>
      {metricsUnavailable && (
        <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: 12 }}>
          Yield &amp; peg metrics are agent-computed — start the agent (<span className="mono">VITE_AGENT_API_URL</span>) to see live values.
        </div>
      )}
    </Card>
  );
}

interface DashboardPageProps {
  connected: boolean; paused: boolean; killed: boolean; emptyPosition: boolean;
  go: (r: Route) => void; onDeposit: () => void; onWithdraw: () => void; onConnect: () => void; loading: boolean;
}

export function DashboardPage({ connected, paused, killed, emptyPosition, go, onDeposit, onWithdraw, onConnect, loading }: DashboardPageProps) {
  const { address } = useAccount();
  const { vault: vaultRaw, position, baseline, isLive: vaultLive } = useVaultData(address);
  // APY/peg/oracle are agent-computed: overlay them from the live /snapshot.
  const { snapshot } = useInsightsData();
  const vault = mergeSnapshotIntoVault(vaultRaw, snapshot);
  // Live vault but no live snapshot → the agent isn't running; show "—" for its
  // metrics instead of the demo fixtures. In demo mode (undeployed) keep fixtures.
  const metricsUnavailable = vaultLive && !snapshot.live;

  if (loading) {
    return (
      <div className="page">
        <div className="grid" style={{ gap: 16 }}>
          <Skeleton h={130} r={14} /><Skeleton h={120} r={14} />
          <div className="grid dash-cols"><Skeleton h={300} r={14} /><Skeleton h={300} r={14} /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">Autonomous risk-guardian vault — your position, vault health, and the agent's current stance at a glance.</p>
        </div>
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <AgentStatusCard go={go} />
        <BaselineCounter baseline={baseline} />
        <div className="grid dash-cols">
          <PositionCard connected={connected} empty={emptyPosition} paused={paused} killed={killed} vault={vault} position={position} metricsUnavailable={metricsUnavailable} onDeposit={onDeposit} onWithdraw={onWithdraw} onConnect={onConnect} />
          <AllocationCard vault={vault} />
        </div>
        <VaultStatsCard vault={vault} metricsUnavailable={metricsUnavailable} />
      </div>
    </div>
  );
}
