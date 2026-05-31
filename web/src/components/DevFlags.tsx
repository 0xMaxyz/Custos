// Demo-states panel (§8). Matches Design/src/devflags.jsx.

import { useState } from "react";
import { Icon } from "./Icons";

export interface AppFlags {
  paused: boolean;
  killed: boolean;
  wrongNet: boolean;
  emptyPosition: boolean;
  activityError: boolean;
}

const TOGGLES: { key: keyof AppFlags; label: string; icon: string }[] = [
  { key: "paused", label: "Deposits paused", icon: "info" },
  { key: "killed", label: "Kill-switch (withdraw-only)", icon: "lock" },
  { key: "wrongNet", label: "Wrong network", icon: "alert-triangle" },
  { key: "emptyPosition", label: "Empty position", icon: "wallet" },
  { key: "activityError", label: "Activity load error", icon: "alert-triangle" },
];

export function DevFlags({ flags, setFlags }: { flags: AppFlags; setFlags: React.Dispatch<React.SetStateAction<AppFlags>> }) {
  const [open, setOpen] = useState(false);
  const set = (k: keyof AppFlags) => setFlags((fl) => ({ ...fl, [k]: !fl[k] }));
  const active = Object.values(flags).filter(Boolean).length;
  return (
    <div className="devflags">
      {open && (
        <div className="devflags-panel" role="dialog" aria-label="Demo states">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Icon name="sparkles" size={15} style={{ color: "var(--primary)" }} />
            <strong style={{ fontSize: "0.875rem", flex: 1 }}>Demo states</strong>
            <button className="iconbtn-sm" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" size={14} /></button>
          </div>
          <p style={{ fontSize: "0.75rem", color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.45 }}>Flip the §8 edge cases to review banners, disabled actions, and empty views.</p>
          <div style={{ display: "grid", gap: 4 }}>
            {TOGGLES.map((t) => (
              <button key={t.key} className="devflag-row" onClick={() => set(t.key)} aria-pressed={!!flags[t.key]}>
                <Icon name={t.icon} size={15} style={{ color: flags[t.key] ? "var(--primary)" : "var(--faint)" }} />
                <span style={{ flex: 1, textAlign: "left" }}>{t.label}</span>
                <span className={"switch" + (flags[t.key] ? " on" : "")}><span className="knob" /></span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="devflags-fab" onClick={() => setOpen((v) => !v)} aria-label="Demo states" title="Demo states">
        <Icon name="sparkles" size={16} />
        {active > 0 && <span className="devflags-count">{active}</span>}
      </button>
    </div>
  );
}
