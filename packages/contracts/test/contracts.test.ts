import { describe, expect, it } from "vitest";
import {
  ClaimSchema,
  EvidenceFieldSchema,
  SourcePointerSchema,
} from "../src/index.js";

describe("evidence contracts", () => {
  it("rejects an observed statement without evidence and an inference without a reason", () => {
    expect(
      EvidenceFieldSchema.safeParse({
        status: "observed",
        value: "Tests passed",
        evidence_event_ids: [],
      }).success,
    ).toBe(false);
    expect(
      EvidenceFieldSchema.safeParse({
        status: "inferred",
        value: "The change fixed the issue",
        evidence_event_ids: ["a".repeat(64)],
      }).success,
    ).toBe(false);
    expect(
      EvidenceFieldSchema.parse({
        status: "unknown",
        value: null,
        evidence_event_ids: [],
      }).value,
    ).toBeNull();
    expect(
      EvidenceFieldSchema.safeParse({
        status: "unknown",
        value: "Invented outcome",
        evidence_event_ids: [],
      }).success,
    ).toBe(false);
  });

  it("rejects reversed source ranges and unsupported claims marked as verified", () => {
    expect(
      SourcePointerSchema.safeParse({
        source_id: "a".repeat(64),
        line_number: 1,
        byte_start: 4,
        byte_end: 2,
        byte_context: "decompressed",
      }).success,
    ).toBe(false);
    expect(
      ClaimSchema.safeParse({
        claim_id: "claim-1",
        text: "Passed",
        evidence_event_ids: ["a".repeat(64)],
        epistemic_status: "observed",
        support_status: "supported",
        verifier_version: null,
      }).success,
    ).toBe(false);
  });
});
