import { describe, it, expect } from "vitest";
import {
  buildAuthorization,
  createPayment,
  decodePaymentHeader,
  decodeSettlement,
  encodePaymentHeader,
  encodeSettlement,
  payAndFetch,
  shapeOnlyVerifier,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type Eip3009Signer,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementReceipt,
} from "./x402.js";

const REQ: PaymentRequirements = {
  scheme: "exact",
  network: "mantle",
  chainId: 5000,
  maxAmountRequired: "10000", // 0.01 USDC (6-dec)
  resource: "https://agent.custos/risk-score",
  description: "Custos RWA risk score",
  mimeType: "application/json",
  payTo: "0x000000000000000000000000000000000000bEEF",
  maxTimeoutSeconds: 60,
  asset: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", // USDC (Mantle)
  extra: { name: "USD Coin", version: "2" },
};

const FROM = "0x000000000000000000000000000000000000A11c" as const;
const SIG = `0x${"ab".repeat(65)}` as const; // 65-byte stub signature

/** Deterministic signer that records the domain it was asked to sign. */
function stubSigner(): { signer: Eip3009Signer; calls: unknown[] } {
  const calls: unknown[] = [];
  const signer: Eip3009Signer = async (args) => {
    calls.push(args);
    return SIG;
  };
  return { signer, calls };
}

describe("x402 encode/decode", () => {
  it("round-trips a payment header", () => {
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "mantle",
      payload: {
        signature: SIG,
        authorization: {
          from: FROM,
          to: REQ.payTo,
          value: "10000",
          validAfter: "100",
          validBefore: "200",
          nonce: `0x${"11".repeat(32)}`,
        },
      },
    };
    expect(decodePaymentHeader(encodePaymentHeader(payload))).toEqual(payload);
  });

  it("round-trips a settlement receipt", () => {
    const receipt: SettlementReceipt = {
      success: true,
      transaction: `0x${"cd".repeat(32)}`,
      network: "mantle",
      payer: FROM,
      amount: "10000",
      resource: REQ.resource,
    };
    expect(decodeSettlement(encodeSettlement(receipt))).toEqual(receipt);
  });
});

describe("buildAuthorization / createPayment", () => {
  it("targets payTo for the required amount with a bounded validity window", () => {
    const auth = buildAuthorization(REQ, FROM, { nowSec: 1_000, nonce: `0x${"22".repeat(32)}` });
    expect(auth.to).toBe(REQ.payTo);
    expect(auth.from).toBe(FROM);
    expect(auth.value).toBe("10000");
    expect(Number(auth.validAfter)).toBeLessThanOrEqual(1_000);
    expect(Number(auth.validBefore)).toBe(1_000 + REQ.maxTimeoutSeconds);
  });

  it("signs over the asset's EIP-712 domain", async () => {
    const { signer, calls } = stubSigner();
    const payment = await createPayment({ requirements: REQ, from: FROM, signer, nowSec: 1_000 });
    expect(payment.payload.signature).toBe(SIG);
    expect(payment.scheme).toBe("exact");
    const domain = (calls[0] as { domain: Record<string, unknown> }).domain;
    expect(domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 5000,
      verifyingContract: REQ.asset,
    });
  });

  it("rejects a required amount above the spend cap BEFORE signing (N1)", async () => {
    const { signer, calls } = stubSigner();
    // REQ.maxAmountRequired = 10000; cap one unit below it.
    await expect(
      createPayment({ requirements: REQ, from: FROM, signer, nowSec: 1_000, maxAmountBaseUnits: 9_999n }),
    ).rejects.toThrow(/exceeds max-spend cap/);
    expect(calls.length).toBe(0); // never signed a counterparty-dictated over-cap amount
  });

  it("signs when the required amount is at or below the spend cap", async () => {
    const { signer } = stubSigner();
    const payment = await createPayment({
      requirements: REQ,
      from: FROM,
      signer,
      nowSec: 1_000,
      maxAmountBaseUnits: 10_000n, // exactly the required amount
    });
    expect(payment.payload.signature).toBe(SIG);
  });
});

describe("payAndFetch (402 -> pay -> 200)", () => {
  /** Minimal in-memory x402 server: 402 unless a valid X-PAYMENT is presented. */
  function makeServer() {
    const verify = shapeOnlyVerifier(() => 1_000);
    let paidCalls = 0;
    const fetchImpl = async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const header = init?.headers?.[PAYMENT_HEADER];
      if (!header) {
        return {
          status: 402,
          headers: { get: () => null },
          json: async () => ({ x402Version: 1, accepts: [REQ], error: "payment required" }),
          text: async () => "",
        };
      }
      const receipt = await verify(decodePaymentHeader(header), REQ);
      if (!receipt) {
        return { status: 402, headers: { get: () => null }, json: async () => ({ accepts: [REQ] }), text: async () => "" };
      }
      paidCalls += 1;
      const respHeader = encodeSettlement(receipt);
      return {
        status: 200,
        headers: { get: (n: string) => (n === PAYMENT_RESPONSE_HEADER ? respHeader : null) },
        json: async () => ({ riskScore: 41, asOf: "2026-06-01T00:00:00Z" }),
        text: async () => "",
      };
    };
    return { fetchImpl, paidCalls: () => paidCalls };
  }

  it("pays on 402 and returns the resource + a binding receipt", async () => {
    const { signer } = stubSigner();
    const { fetchImpl, paidCalls } = makeServer();
    const res = await payAndFetch<{ riskScore: number }>({
      url: REQ.resource,
      from: FROM,
      signer,
      fetchImpl,
      nowSec: 1_000,
    });
    expect(res.status).toBe(200);
    expect(res.data.riskScore).toBe(41);
    expect(res.receipt?.success).toBe(true);
    expect(res.receipt?.payer).toBe(FROM);
    expect(res.receipt?.amount).toBe("10000");
    expect(res.receipt?.resource).toBe(REQ.resource); // binds receipt to the evidence bought
    expect(paidCalls()).toBe(1);
  });

  it("throws without paying when the 402 price exceeds the spend cap (N1)", async () => {
    const { signer, calls } = stubSigner();
    const { fetchImpl, paidCalls } = makeServer();
    await expect(
      payAndFetch({
        url: REQ.resource,
        from: FROM,
        signer,
        fetchImpl,
        nowSec: 1_000,
        maxAmountBaseUnits: 9_999n, // below REQ.maxAmountRequired (10000)
      }),
    ).rejects.toThrow(/exceeds max-spend cap/);
    expect(calls.length).toBe(0); // never signed
    expect(paidCalls()).toBe(0); // resource never unlocked
  });

  it("does not pay when the resource is already free (non-402)", async () => {
    const { signer, calls } = stubSigner();
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ riskScore: 7 }),
      text: async () => "",
    });
    const res = await payAndFetch<{ riskScore: number }>({ url: REQ.resource, from: FROM, signer, fetchImpl });
    expect(res.data.riskScore).toBe(7);
    expect(res.receipt).toBeUndefined();
    expect(calls.length).toBe(0); // never signed a payment
  });
});

describe("shapeOnlyVerifier", () => {
  const now = () => 1_000;
  async function paymentTo(to: `0x${string}`, value: string, validBefore = "1060"): Promise<PaymentPayload> {
    return {
      x402Version: 1,
      scheme: "exact",
      network: "mantle",
      payload: {
        signature: SIG,
        authorization: { from: FROM, to, value, validAfter: "995", validBefore, nonce: `0x${"33".repeat(32)}` },
      },
    };
  }

  it("accepts a well-formed, sufficient, unexpired payment", async () => {
    const r = await shapeOnlyVerifier(now)(await paymentTo(REQ.payTo, "10000"), REQ);
    expect(r?.success).toBe(true);
    expect(r?.amount).toBe("10000");
  });

  it("rejects wrong recipient", async () => {
    const r = await shapeOnlyVerifier(now)(await paymentTo(FROM, "10000"), REQ);
    expect(r).toBeNull();
  });

  it("rejects underpayment", async () => {
    const r = await shapeOnlyVerifier(now)(await paymentTo(REQ.payTo, "9999"), REQ);
    expect(r).toBeNull();
  });

  it("rejects an expired authorization", async () => {
    const r = await shapeOnlyVerifier(now)(await paymentTo(REQ.payTo, "10000", "999"), REQ);
    expect(r).toBeNull();
  });
});
