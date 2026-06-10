/**
 * Typed execution failures (O1 / O2).
 *
 * The scheduler logs `runCycle()` throws, but a *failed de-risk* — one that was
 * REQUIRED (deterministic `forceDeRisk` or an LLM `deRisk` verdict) yet did not
 * confirm on-chain — must surface as a structured, loud failure so the operator
 * is paged. `CycleFailureError` carries enough context for `index.ts` to decide
 * whether to fire a CRITICAL alert (vs. quietly logging a routine RPC blip).
 */

/** Where in the cycle the failure happened. */
export type CycleStage =
  | "submit" // writeContract reverted / RPC rejected the tx
  | "receipt"; // tx submitted but the receipt never confirmed (timeout / failure)

export interface CycleFailureContext {
  /** True when the failing cycle was a required de-risk (forced or LLM-verdict). */
  readonly deRiskRequired: boolean;
  /** Coarse stage tag for the alert / logs. */
  readonly stage: CycleStage;
  /** The original error (network error, revert, timeout). */
  readonly cause: unknown;
  /** Tx hash, when the failure occurred after the tx was broadcast. */
  readonly txHash?: `0x${string}` | undefined;
  /** Whether this was a de-risk or rebalance attempt, for the message. */
  readonly kind: "derisk" | "rebalance";
}

/**
 * A structured cycle failure. Distinct from an ordinary `Error` so the scheduler's
 * failure path can branch on `deRiskRequired` without string-matching messages.
 */
export class CycleFailureError extends Error {
  readonly deRiskRequired: boolean;
  readonly stage: CycleStage;
  override readonly cause: unknown;
  readonly txHash?: `0x${string}` | undefined;
  readonly kind: "derisk" | "rebalance";

  constructor(ctx: CycleFailureContext) {
    const causeMsg = ctx.cause instanceof Error ? ctx.cause.message : String(ctx.cause);
    super(
      `${ctx.kind} cycle failed at ${ctx.stage}` +
        (ctx.txHash ? ` (tx ${ctx.txHash})` : "") +
        `: ${causeMsg}`,
    );
    this.name = "CycleFailureError";
    this.deRiskRequired = ctx.deRiskRequired;
    this.stage = ctx.stage;
    this.cause = ctx.cause;
    this.txHash = ctx.txHash;
    this.kind = ctx.kind;
  }
}

/** Type guard for the scheduler / index failure path. */
export function isCycleFailure(e: unknown): e is CycleFailureError {
  return e instanceof CycleFailureError;
}
