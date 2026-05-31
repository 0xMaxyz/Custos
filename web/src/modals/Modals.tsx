// Modal shell: focus-trap, Esc, scroll-lock. Matches Design/src/modals.jsx.
// Connect / network / account flows are handled by RainbowKit's ConnectButton.

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../components/Icons";

export function Modal({ title, icon, onClose, children, footer, size }: {
  title: string; icon?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const el = ref.current!;
    const focusables = () => el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusables()[0]; first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const fs = focusables(); if (!fs.length) return;
        const a = fs[0]!, z = fs[fs.length - 1]!;
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; prev?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"modal" + (size === "lg" ? " modal-lg" : "")} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          {icon && <span className="brand-mark" style={{ width: 30, height: 30, background: "var(--primary-soft)", color: "var(--primary)" }}><Icon name={icon} size={17} /></span>}
          <h2 className="modal-title">{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
