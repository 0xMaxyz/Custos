// Deposit / withdraw transaction logic (ROADMAP 4.5).
//
// Pure, chain-independent validation + phase-transition helpers so the trade
// modals have a single tested source of truth for amounts, errors, previews, and
// the approve→deposit / withdraw step machine. Components own only rendering and
// the async side-effects (wallet calls); all decisions live here and are unit
// tested without a DOM or a chain.

// ── Guardrail constants surfaced in the UI ────────────────────────────────────
// Sourced from packages/shared (the single source of truth shared with the on-chain
// Guardrails) so UI caps never drift. The web app works in human USDC units, so we
// convert the 6-decimal shared constant down by 1e6.

import { PER_TX_DEPOSIT_CAP_USDC } from "@sentinel/shared";

/** Per-transaction deposit cap (human USDC). Derived from PER_TX_DEPOSIT_CAP_USDC. */
export const PER_TX_DEPOSIT_CAP = PER_TX_DEPOSIT_CAP_USDC / 1_000_000;

/** Max slippage surfaced for large (USDY-unwinding) withdrawals, in percent. */
export const MAX_SLIPPAGE_PCT = 0.5;

// ── Deposit ───────────────────────────────────────────────────────────────────

export type DepositPhase =
  | "form"
  | "approving"
  | "approved"
  | "depositing"
  | "done"
  | "failed";

export interface DepositInputs {
  /** Raw amount string from the input field. */
  amount: string;
  /** Spendable wallet USDC balance. */
  walletBalance: number;
  /** Current vault TVL (USDC). */
  tvl: number;
  /** Vault TVL cap (USDC). */
  tvlCap: number;
  /** Share price (USDC per share). */
  sharePrice: number;
}

export interface DepositPreview {
  /** Parsed numeric amount (0 when blank/invalid). */
  amount: number;
  /** Shares minted for `amount` at the current share price. */
  sharesOut: number;
  /** Remaining vault capacity (cap − tvl, floored at 0). */
  remainingCapacity: number;
  /** The largest amount the user could deposit (min of balance, per-tx cap, capacity). */
  maxDepositable: number;
  /** First failing validation message, or null when valid. */
  error: string | null;
  /** True when `amount` > 0 and there is no error. */
  valid: boolean;
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function previewDeposit(inputs: DepositInputs): DepositPreview {
  const amount = parseFloat(inputs.amount) || 0;
  const remainingCapacity = Math.max(0, inputs.tvlCap - inputs.tvl);
  const maxDepositable = Math.max(
    0,
    Math.min(inputs.walletBalance, PER_TX_DEPOSIT_CAP, remainingCapacity),
  );
  const sharesOut = inputs.sharePrice > 0 ? amount / inputs.sharePrice : 0;

  let error: string | null = null;
  if (amount > inputs.walletBalance) error = "Exceeds wallet balance";
  else if (amount > PER_TX_DEPOSIT_CAP) error = `Over per-tx cap of ${usd(PER_TX_DEPOSIT_CAP)}`;
  else if (amount > remainingCapacity) {
    error = `Only ${usd(remainingCapacity)} of vault capacity left`;
  }

  return {
    amount,
    sharesOut,
    remainingCapacity,
    maxDepositable,
    error,
    valid: amount > 0 && error === null,
  };
}

/**
 * The deposit flow is a two-step approve→deposit machine. `depositStepIndex`
 * maps a phase onto the stepper's active step (0 = Approve, 1 = Deposit).
 */
export function depositStepIndex(phase: DepositPhase): 0 | 1 {
  return phase === "form" || phase === "approving" ? 0 : 1;
}

/** True while a deposit tx is in flight (UI should lock inputs + close). */
export function isDepositBusy(phase: DepositPhase): boolean {
  return phase === "approving" || phase === "depositing";
}

/**
 * Next phase for a successful step transition. Encodes the legal ordering:
 *   form → approving → approved → depositing → done
 * Any other phase is terminal/unchanged. Failures are applied separately via
 * `failDeposit` so a thrown wallet error can short-circuit from any in-flight step.
 */
export function nextDepositPhase(phase: DepositPhase): DepositPhase {
  switch (phase) {
    case "form":
      return "approving";
    case "approving":
      return "approved";
    case "approved":
      return "depositing";
    case "depositing":
      return "done";
    default:
      return phase;
  }
}

export function failDeposit(): DepositPhase {
  return "failed";
}

// ── Withdraw ──────────────────────────────────────────────────────────────────

export type WithdrawUnit = "USDC" | "shares";
export type WithdrawPhase = "form" | "withdrawing" | "done" | "failed";

export interface WithdrawInputs {
  amount: string;
  unit: WithdrawUnit;
  /** Position value in USDC. */
  positionUsdc: number;
  /** Position size in shares. */
  positionShares: number;
  /** Instant-withdrawable liquidity (idle + Aave), USDC. */
  instantUsdc: number;
  sharePrice: number;
}

export interface WithdrawPreview {
  amount: number;
  /** USDC the user receives. */
  usdcOut: number;
  /** Shares burned. */
  sharesIn: number;
  /** Max withdrawable in the selected unit. */
  max: number;
  /** True when the USDC out exceeds instant liquidity (partial USDY unwind). */
  exceedsInstant: boolean;
  error: string | null;
  valid: boolean;
}

export function previewWithdraw(inputs: WithdrawInputs): WithdrawPreview {
  const amount = parseFloat(inputs.amount) || 0;
  const sp = inputs.sharePrice;
  const usdcOut = inputs.unit === "USDC" ? amount : amount * sp;
  const sharesIn = inputs.unit === "shares" ? amount : (sp > 0 ? amount / sp : 0);
  const max = inputs.unit === "USDC" ? inputs.positionUsdc : inputs.positionShares;

  let error: string | null = null;
  // Small epsilon so an exact "max" entered as a rounded string still validates.
  if (amount > max + 0.001) error = "Exceeds your position";

  return {
    amount,
    usdcOut,
    sharesIn,
    max,
    exceedsInstant: usdcOut > inputs.instantUsdc,
    error,
    valid: amount > 0 && error === null,
  };
}

export function isWithdrawBusy(phase: WithdrawPhase): boolean {
  return phase === "withdrawing";
}
