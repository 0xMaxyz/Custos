/** A 0x-prefixed EVM address (lowercase or checksummed). */
export type Address = `0x${string}`;

/** Allocation buckets, matching the on-chain `Guardrails` bucket ids. */
export enum Bucket {
  IDLE = 0,
  AAVE = 1,
  USDY = 2,
  AUSD = 3,
}

/** Risk level the agent may assign — it may only tighten, never loosen. */
export type RiskLevel = "NORMAL" | "CAUTION" | "DERISK";

/** Provenance marker for an on-chain address record. */
export interface AddressRecord {
  readonly address: Address;
  /**
   * How this address was established. `onchain@<block>` once re-confirmed via a
   * live RPC; `source:<ref>` when taken from an authoritative off-chain source.
   */
  readonly provenance: string;
}
