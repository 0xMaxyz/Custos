import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPayment, type Eip3009Signer, type PaymentRequirements } from "./x402.js";
import { onChainSettlingVerifier, recoverPaymentSigner, signatureVerifyingVerifier } from "./verifier.js";

const REQ: PaymentRequirements = {
  scheme: "exact",
  network: "mantle",
  chainId: 5000,
  maxAmountRequired: "10000",
  resource: "https://agent.custos/risk-score",
  description: "Custos RWA risk score",
  mimeType: "application/json",
  payTo: "0x000000000000000000000000000000000000bEEF",
  maxTimeoutSeconds: 120,
  asset: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  extra: { name: "USD Coin", version: "2" },
};

// A real key so we sign + recover genuine EIP-712 signatures.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const signer: Eip3009Signer = (def) =>
  account.signTypedData(def as unknown as Parameters<typeof account.signTypedData>[0]);

const AT = 1_000;
const validPayment = () => createPayment({ requirements: REQ, from: account.address, signer, nowSec: AT });

describe("recoverPaymentSigner / signatureVerifyingVerifier", () => {
  it("recovers the genuine EIP-712 signer", async () => {
    const payment = await validPayment();
    const recovered = await recoverPaymentSigner(payment, REQ);
    expect(recovered?.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("accepts a genuinely-signed, in-bounds payment", async () => {
    const payment = await validPayment();
    const r = await signatureVerifyingVerifier(() => AT)(payment, REQ);
    expect(r?.success).toBe(true);
    expect(r?.payer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(r?.amount).toBe("10000");
  });

  it("rejects a tampered authorization (signature no longer recovers to `from`)", async () => {
    const payment = await validPayment();
    // Bump value (still >= required, so it passes bounds) — but it wasn't signed over 20000.
    const tampered = {
      ...payment,
      payload: { ...payment.payload, authorization: { ...payment.payload.authorization, value: "20000" } },
    };
    const r = await signatureVerifyingVerifier(() => AT)(tampered, REQ);
    expect(r).toBeNull();
  });

  it("rejects an expired authorization before checking the signature", async () => {
    const payment = await validPayment();
    const r = await signatureVerifyingVerifier(() => AT + 10_000)(payment, REQ);
    expect(r).toBeNull();
  });
});

describe("onChainSettlingVerifier", () => {
  function mockChain(status: "success" | "reverted" = "success", hash: `0x${string}` = `0x${"fe".repeat(32)}`) {
    const writeContract = vi.fn(async () => hash);
    const waitForTransactionReceipt = vi.fn(async () => ({ status }));
    return {
      walletClient: { writeContract, chain: { id: 5000 }, account: { address: account.address } } as never,
      publicClient: { waitForTransactionReceipt } as never,
      writeContract,
      waitForTransactionReceipt,
      hash,
    };
  }

  it("settles a verified payment via transferWithAuthorization and returns the tx hash", async () => {
    const { walletClient, publicClient, writeContract, waitForTransactionReceipt, hash } = mockChain();
    const verify = onChainSettlingVerifier({ walletClient, publicClient, asset: REQ.asset, nowSec: () => AT });
    const r = await verify(await validPayment(), REQ);

    expect(r?.transaction).toBe(hash);
    expect(r?.payer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(writeContract).toHaveBeenCalledOnce();
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    const call = (writeContract.mock.calls[0] as unknown as [{ functionName: string; args: unknown[] }])[0];
    expect(call.functionName).toBe("transferWithAuthorization");
    expect((call.args[0] as string).toLowerCase()).toBe(account.address.toLowerCase()); // from
    expect(call.args[1]).toBe(REQ.payTo); // to
    expect(call.args[2]).toBe(10_000n); // value
  });

  it("fails closed when the settlement tx reverts on-chain (no 200)", async () => {
    const { walletClient, publicClient, writeContract } = mockChain("reverted");
    const verify = onChainSettlingVerifier({ walletClient, publicClient, asset: REQ.asset, nowSec: () => AT });
    const r = await verify(await validPayment(), REQ);
    expect(r).toBeNull(); // a mined-but-reverted transferWithAuthorization must not unlock
    expect(writeContract).toHaveBeenCalledOnce(); // it did submit; the revert is what fails closed
  });

  it("does NOT submit settlement for an invalid signature", async () => {
    const { walletClient, publicClient, writeContract } = mockChain();
    const verify = onChainSettlingVerifier({ walletClient, publicClient, asset: REQ.asset, nowSec: () => AT });
    const payment = await validPayment();
    const tampered = {
      ...payment,
      payload: { ...payment.payload, authorization: { ...payment.payload.authorization, value: "20000" } },
    };
    const r = await verify(tampered, REQ);
    expect(r).toBeNull();
    expect(writeContract).not.toHaveBeenCalled();
  });
});
