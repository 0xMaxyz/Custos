import {
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  eip3009TypedData,
  encodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentVerifier,
  type SettlementReceipt,
} from "./x402.js";

/**
 * Production x402 verifiers (A4.1 follow-up) — replace the dev-only `shapeOnlyVerifier`
 * with real verification. Two strengths:
 *
 *  - {@link signatureVerifyingVerifier}: checks bounds AND recovers the EIP-712
 *    signer, so the payment is provably authorized by `from`. Settlement is delegated
 *    (facilitator) — the receipt's `transaction` is a content-addressed reference.
 *  - {@link onChainSettlingVerifier}: verifies the signature, then SETTLES by submitting
 *    `transferWithAuthorization` (EIP-3009) on-chain and returns the real tx hash. Use
 *    this when Sentinel captures the payment itself.
 *
 * Neither touches the vault custody path; both keep settlement an explicit, auditable step.
 */

/** Shared bounds check: recipient, amount, validity window, signature shape. */
function checkBounds(payment: PaymentPayload, requirements: PaymentRequirements, now: number): boolean {
  if (payment.scheme !== "exact") return false;
  const a = payment.payload.authorization;
  if (a.to.toLowerCase() !== requirements.payTo.toLowerCase()) return false;
  if (BigInt(a.value) < BigInt(requirements.maxAmountRequired)) return false;
  if (Number(a.validBefore) < now || Number(a.validAfter) > now) return false;
  return /^0x[0-9a-fA-F]{130}$/.test(payment.payload.signature);
}

/** Recover the EIP-712 signer of an x402 payment; null if recovery fails. */
export async function recoverPaymentSigner(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<`0x${string}` | null> {
  try {
    const td = eip3009TypedData(requirements, payment.payload.authorization);
    return await recoverTypedDataAddress({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
      signature: payment.payload.signature,
    });
  } catch {
    return null;
  }
}

/**
 * Verifies bounds + the EIP-712 signature recovers to `from`. Does NOT settle on-chain
 * (a facilitator does) — appropriate when payment capture is delegated.
 */
export function signatureVerifyingVerifier(
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): PaymentVerifier {
  return async (payment, requirements) => {
    if (!checkBounds(payment, requirements, nowSec())) return null;
    const signer = await recoverPaymentSigner(payment, requirements);
    if (!signer || signer.toLowerCase() !== payment.payload.authorization.from.toLowerCase()) {
      return null;
    }
    const ref = keccak256(toBytes(encodePaymentHeader(payment)));
    return receipt(payment, requirements, ref);
  };
}

/** EIP-3009 `transferWithAuthorization` (bytes-signature variant, e.g. USDC v2). */
export const transferWithAuthorizationAbi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface OnChainSettleDeps {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  /** The EIP-3009 asset (e.g. USDC). */
  readonly asset: `0x${string}`;
  readonly nowSec?: () => number;
}

/**
 * Verifies the signature, then SETTLES by submitting `transferWithAuthorization`
 * on-chain (anyone may submit an EIP-3009 meta-tx; Sentinel relays it). Returns the
 * real settlement tx hash. Returns null (and submits nothing) if verification fails.
 */
export function onChainSettlingVerifier(deps: OnChainSettleDeps): PaymentVerifier {
  const verifySig = signatureVerifyingVerifier(deps.nowSec);
  return async (payment, requirements) => {
    const pre = await verifySig(payment, requirements);
    if (!pre) return null; // never submit an unverified authorization

    const a = payment.payload.authorization;
    try {
      const hash = await deps.walletClient.writeContract({
        address: deps.asset,
        abi: transferWithAuthorizationAbi,
        functionName: "transferWithAuthorization",
        args: [
          a.from,
          a.to,
          BigInt(a.value),
          BigInt(a.validAfter),
          BigInt(a.validBefore),
          a.nonce,
          payment.payload.signature,
        ],
        chain: deps.walletClient.chain,
        account: deps.walletClient.account ?? null,
      });
      const rcpt = await deps.publicClient.waitForTransactionReceipt({ hash });
      // Fail closed: a reverted settlement (used nonce, insufficient balance, …) must
      // NOT unlock the resource even though the tx was mined.
      if (rcpt.status !== "success") return null;
      return receipt(payment, requirements, hash);
    } catch {
      return null; // submission threw (RPC error, rejected, …)
    }
  };
}

function receipt(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  transaction: `0x${string}` | string,
): SettlementReceipt {
  return {
    success: true,
    transaction,
    network: requirements.network,
    payer: payment.payload.authorization.from,
    amount: payment.payload.authorization.value,
    resource: requirements.resource,
  };
}
