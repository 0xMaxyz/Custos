import { describe, it, expect } from "vitest";
import {
  resolveDecisionUri,
  isInlineDataUri,
  decodeInlineJson,
  DEFAULT_IPFS_GATEWAY,
} from "./decisionUri";

describe("resolveDecisionUri", () => {
  it("maps ipfs:// to the gateway /ipfs/<cid> path", () => {
    expect(resolveDecisionUri("ipfs://bafyCID")).toBe(`${DEFAULT_IPFS_GATEWAY}/ipfs/bafyCID`);
  });

  it("preserves a sub-path after the cid", () => {
    expect(resolveDecisionUri("ipfs://bafyCID/rationale.json")).toBe(
      `${DEFAULT_IPFS_GATEWAY}/ipfs/bafyCID/rationale.json`,
    );
  });

  it("tolerates an ipfs://ipfs/ double prefix", () => {
    expect(resolveDecisionUri("ipfs://ipfs/bafyCID")).toBe(`${DEFAULT_IPFS_GATEWAY}/ipfs/bafyCID`);
  });

  it("passes through http(s) and data URIs unchanged", () => {
    expect(resolveDecisionUri("https://example.com/x.json")).toBe("https://example.com/x.json");
    expect(resolveDecisionUri("data:application/json;base64,e30=")).toBe(
      "data:application/json;base64,e30=",
    );
  });

  it("returns null for empty / unsupported / cid-less URIs", () => {
    expect(resolveDecisionUri("")).toBeNull();
    expect(resolveDecisionUri(undefined)).toBeNull();
    expect(resolveDecisionUri(null)).toBeNull();
    expect(resolveDecisionUri("ipfs://")).toBeNull();
    expect(resolveDecisionUri("ftp://nope")).toBeNull();
  });
});

describe("isInlineDataUri", () => {
  it("detects data URIs", () => {
    expect(isInlineDataUri("data:application/json;base64,e30=")).toBe(true);
    expect(isInlineDataUri("ipfs://bafy")).toBe(false);
    expect(isInlineDataUri(undefined)).toBe(false);
  });
});

describe("decodeInlineJson", () => {
  it("decodes a base64 data URI to its object", () => {
    const obj = { rationale: "test", riskLevel: "NORMAL" };
    const b64 = btoa(JSON.stringify(obj));
    const decoded = decodeInlineJson<typeof obj>(`data:application/json;base64,${b64}`);
    expect(decoded).toEqual(obj);
  });

  it("decodes a percent-encoded (non-base64) data URI", () => {
    const obj = { a: 1 };
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify(obj))}`;
    expect(decodeInlineJson<typeof obj>(uri)).toEqual(obj);
  });

  it("returns null for non-data URIs and malformed payloads", () => {
    expect(decodeInlineJson("ipfs://bafy")).toBeNull();
    expect(decodeInlineJson("data:application/json;base64,@@notb64@@")).toBeNull();
    expect(decodeInlineJson("data:application/json;base64")).toBeNull();
  });
});
