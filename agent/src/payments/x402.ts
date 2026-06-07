import { keccak256, toBytes } from "viem";

/**
 * x402 micropayments (ROADMAP A4.1).
 *
 * Minimal, dependency-light implementation of Coinbase's x402 "exact" EVM scheme
 * (now stewarded by the x402 Foundation). It lets the agent:
 *   1. PAY per-call for premium risk/data feeds — the returned settlement receipt is
 *      pinned into the decision evidence bundle ("the agent paid for the evidence it
 *      acted on"); and
 *   2. CHARGE other agents for Custos's RWA risk score via a 402-gated endpoint
 *      (see `server.ts` `GET /risk-score`).
 *
 * Flow (HTTP-native):
 *   client GET  /resource                     -> 402 + { accepts: [PaymentRequirements] }
 *   client GET  /resource  (X-PAYMENT header)  -> 200 + body + X-PAYMENT-RESPONSE header
 *
 * The `X-PAYMENT` header is base64(JSON) of a signed EIP-3009 `transferWithAuthorization`
 * (EIP-712). Settlement (submitting the authorization on-chain) is delegated to an
 * injectable `facilitator`/`verifier` so the protocol logic is testable without a live
 * chain. We never trust a self-reported amount: the verifier re-derives what was
 * authorized from the signed payload.
 */

/** A 402 "accepts" entry describing how to pay for a resource (x402 "exact" scheme). */
export interface PaymentRequirements {
  /** Payment scheme. Only "exact" is implemented. */
  readonly scheme: "exact";
  /** Human network label, e.g. "mantle". */
  readonly network: string;
  /** EVM chain id used in the EIP-712 domain (e.g. 5000 for Mantle). */
  readonly chainId: number;
  /** Required amount in the asset's base units, as a decimal string (e.g. "10000" = 0.01 USDC). */
  readonly maxAmountRequired: string;
  /** The resource URL being paid for. */
  readonly resource: string;
  readonly description: string;
  readonly mimeType: string;
  /** Recipient of the payment. */
  readonly payTo: `0x${string}`;
  /** Max seconds the signed authorization stays valid. */
  readonly maxTimeoutSeconds: number;
  /** ERC-20 (EIP-3009-capable, e.g. USDC) used for settlement; the EIP-712 verifyingContract. */
  readonly asset: `0x${string}`;
  /** EIP-712 domain `name`/`version` for the asset's `transferWithAuthorization`. */
  readonly extra: { readonly name: string; readonly version: string };
}

/** EIP-3009 `transferWithAuthorization` authorization tuple (JSON/header form). */
export interface Eip3009Authorization {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  /** Base units, decimal string. */
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  /** 32-byte hex nonce. */
  readonly nonce: `0x${string}`;
}

/**
 * EIP-712 message form of {@link Eip3009Authorization} (uint256 fields as `bigint`).
 * The header serializes the string form (JSON-safe); signing + verification use this
 * canonical bigint form so the typed-data hash is unambiguous and viem-compatible.
 */
export interface Eip3009Message {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: `0x${string}`;
}

export function toEip3009Message(a: Eip3009Authorization): Eip3009Message {
  return {
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

/** The decoded `X-PAYMENT` header payload. */
export interface PaymentPayload {
  readonly x402Version: number;
  readonly scheme: "exact";
  readonly network: string;
  readonly payload: {
    readonly signature: `0x${string}`;
    readonly authorization: Eip3009Authorization;
  };
}

/** The decoded `X-PAYMENT-RESPONSE` settlement receipt. */
export interface SettlementReceipt {
  readonly success: boolean;
  /** Settlement tx hash (or a facilitator reference). */
  readonly transaction: `0x${string}` | string;
  readonly network: string;
  readonly payer: `0x${string}`;
  /** Amount settled in base units (decimal string) — what the agent actually paid. */
  readonly amount: string;
  /** The resource the payment was for (binds the receipt to the evidence it bought). */
  readonly resource: string;
}

export const X402_VERSION = 1 as const;
export const PAYMENT_HEADER = "x-payment" as const;
export const PAYMENT_RESPONSE_HEADER = "x-payment-response" as const;

/** EIP-712 types for EIP-3009 TransferWithAuthorization (asset-agnostic). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Signs an EIP-3009 authorization (EIP-712). Injectable so production uses a viem
 * account and tests use a deterministic stub. `domain`/`types`/`message` mirror what
 * `signTypedData` expects.
 */
export interface Eip3009TypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: `0x${string}`;
  };
  readonly types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  readonly primaryType: "TransferWithAuthorization";
  readonly message: Eip3009Message;
}

export type Eip3009Signer = (args: Eip3009TypedData) => Promise<`0x${string}`>;

/** Build the EIP-712 typed-data definition for a payment (used to sign + verify). */
export function eip3009TypedData(
  requirements: PaymentRequirements,
  authorization: Eip3009Authorization,
): Eip3009TypedData {
  return {
    domain: {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: requirements.chainId,
      verifyingContract: requirements.asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: toEip3009Message(authorization),
  };
}

// ── encode / decode ──────────────────────────────────────────────────────────

function b64encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function b64decode<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return b64encode(payload);
}

export function decodePaymentHeader(header: string): PaymentPayload {
  return b64decode<PaymentPayload>(header);
}

export function encodeSettlement(receipt: SettlementReceipt): string {
  return b64encode(receipt);
}

export function decodeSettlement(header: string): SettlementReceipt {
  return b64decode<SettlementReceipt>(header);
}

// ── authorization construction ───────────────────────────────────────────────

/** Random 32-byte nonce as 0x-hex (defaults to crypto when available). */
export function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Build the EIP-3009 authorization tuple for a payment against `requirements`. */
export function buildAuthorization(
  requirements: PaymentRequirements,
  from: `0x${string}`,
  opts: { nowSec?: number | undefined; nonce?: `0x${string}` | undefined } = {},
): Eip3009Authorization {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    from,
    to: requirements.payTo,
    value: requirements.maxAmountRequired,
    // validAfter slightly in the past to tolerate clock skew at the verifier.
    validAfter: String(now - 5),
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce: opts.nonce ?? randomNonce(),
  };
}

/**
 * Build + sign a complete x402 PaymentPayload for `requirements`. The signature is
 * an EIP-3009 authorization over the asset's EIP-712 domain.
 */
export async function createPayment(args: {
  readonly requirements: PaymentRequirements;
  readonly from: `0x${string}`;
  readonly signer: Eip3009Signer;
  readonly nowSec?: number | undefined;
  readonly nonce?: `0x${string}` | undefined;
  /**
   * Hard ceiling (base units) on what we'll authorize. `requirements.maxAmountRequired`
   * comes from the counterparty's 402 response, so without a cap a malicious feed could
   * demand an arbitrary amount and we'd sign it. Reject above the cap BEFORE signing (N1).
   */
  readonly maxAmountBaseUnits?: bigint | undefined;
}): Promise<PaymentPayload> {
  const { requirements, from, signer } = args;
  if (requirements.scheme !== "exact") {
    throw new Error(`unsupported x402 scheme: ${requirements.scheme}`);
  }
  if (
    args.maxAmountBaseUnits !== undefined &&
    BigInt(requirements.maxAmountRequired) > args.maxAmountBaseUnits
  ) {
    throw new Error(
      `x402: required amount ${requirements.maxAmountRequired} exceeds max-spend cap ${args.maxAmountBaseUnits}`,
    );
  }
  const authorization = buildAuthorization(requirements, from, {
    nowSec: args.nowSec,
    nonce: args.nonce,
  });
  const signature = await signer(eip3009TypedData(requirements, authorization));
  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: requirements.network,
    payload: { signature, authorization },
  };
}

// ── client: pay-and-fetch ─────────────────────────────────────────────────────

export interface FetchLikeResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchLikeResponse>;

export interface PaidResult<T> {
  readonly status: number;
  readonly data: T;
  /** Present when the resource required (and we completed) a payment. */
  readonly receipt?: SettlementReceipt;
}

/**
 * GET `url`; if it answers 402, pay per the first supported `accepts` entry and
 * retry once with the `X-PAYMENT` header. Returns the resource plus the settlement
 * receipt (so callers can pin "what they paid for the evidence").
 *
 * Pure w.r.t. transport + signing: both are injected. Throws if the resource still
 * isn't 200 after paying, or if no supported payment requirement is offered.
 */
export async function payAndFetch<T = unknown>(args: {
  readonly url: string;
  readonly from: `0x${string}`;
  readonly signer: Eip3009Signer;
  readonly fetchImpl: FetchLike;
  readonly nowSec?: number;
  /** Hard ceiling (base units) on what we'll pay; over-cap requirements throw before signing (N1). */
  readonly maxAmountBaseUnits?: bigint | undefined;
}): Promise<PaidResult<T>> {
  const { url, from, signer, fetchImpl } = args;

  const first = await fetchImpl(url);
  if (first.status !== 402) {
    return { status: first.status, data: (await first.json()) as T };
  }

  const body = (await first.json()) as { accepts?: PaymentRequirements[] };
  const requirements = body.accepts?.find((r) => r.scheme === "exact");
  if (!requirements) {
    throw new Error("x402: no supported 'exact' payment requirement offered");
  }

  const payment = await createPayment({
    requirements,
    from,
    signer,
    nowSec: args.nowSec,
    maxAmountBaseUnits: args.maxAmountBaseUnits,
  });
  const retried = await fetchImpl(url, {
    headers: { [PAYMENT_HEADER]: encodePaymentHeader(payment) },
  });

  if (retried.status !== 200) {
    throw new Error(`x402: payment did not unlock resource (HTTP ${retried.status})`);
  }

  const data = (await retried.json()) as T;
  const receiptHeader = retried.headers.get(PAYMENT_RESPONSE_HEADER);
  const receipt = receiptHeader ? decodeSettlement(receiptHeader) : undefined;
  return receipt ? { status: 200, data, receipt } : { status: 200, data };
}

// ── server: verify an inbound payment ─────────────────────────────────────────

/**
 * Settles/verifies an inbound `X-PAYMENT` against `requirements`. Returns a receipt
 * on success or null on failure. Injectable: production wires a facilitator or an
 * on-chain `transferWithAuthorization`; tests stub it. The default
 * {@link shapeOnlyVerifier} checks structure + amount/recipient only (no settlement)
 * and is meant for local/dev — never trust it for real value.
 */
export type PaymentVerifier = (
  payment: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<SettlementReceipt | null>;

/**
 * Dev/local verifier: confirms the payload targets the right recipient, pays at least
 * the required amount, hasn't expired, and is structurally a signed authorization.
 * Does NOT settle on-chain — production must inject a facilitator-backed verifier.
 */
export function shapeOnlyVerifier(nowSec: () => number = () => Math.floor(Date.now() / 1000)): PaymentVerifier {
  return async (payment, requirements) => {
    if (payment.scheme !== "exact") return null;
    const a = payment.payload.authorization;
    if (a.to.toLowerCase() !== requirements.payTo.toLowerCase()) return null;
    if (BigInt(a.value) < BigInt(requirements.maxAmountRequired)) return null;
    const now = nowSec();
    if (Number(a.validBefore) < now || Number(a.validAfter) > now) return null;
    if (!/^0x[0-9a-fA-F]{130}$/.test(payment.payload.signature)) return null;
    // Deterministic, content-addressed pseudo-tx ref (not an on-chain settlement).
    const ref = keccak256(toBytes(encodePaymentHeader(payment)));
    return {
      success: true,
      transaction: ref,
      network: requirements.network,
      payer: a.from,
      amount: a.value,
      resource: requirements.resource,
    };
  };
}
