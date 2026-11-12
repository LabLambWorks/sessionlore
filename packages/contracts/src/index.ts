import { z } from "zod";

export const SCHEMA_VERSION = "1";
export const SessionHostSchema = z.enum(["codex", "claude", "opencode"]);
export type SessionHost = z.infer<typeof SessionHostSchema>;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const EventIdSchema = HashSchema;
export const SourcePointerSchema = z
  .object({
    source_id: HashSchema,
    line_number: z.number().int().positive(),
    byte_start: z.number().int().nonnegative(),
    byte_end: z.number().int().nonnegative(),
    byte_context: z.literal("decompressed"),
  })
  .refine((ref) => ref.byte_end >= ref.byte_start, "Invalid source byte range");

export const RawSourceSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  source_id: HashSchema,
  decoded_sha256: HashSchema,
  source: z.enum(["codex", "claude", "grok", "opencode"]),
  discovered_path: z.string().min(1),
  compression: z.enum(["none", "zstd"]),
  size_bytes: z.number().int().nonnegative(),
  mtime: z.iso.datetime({ offset: true }),
  ingested_at: z.iso.datetime({ offset: true }),
  adapter_version: z.string().regex(/^[a-zA-Z0-9._-]+$/),
});

export const NormalizedEventSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    event_id: EventIdSchema,
    source: z.enum(["codex", "claude", "grok", "opencode"]),
    thread_id: z.string().min(1),
    logical_session_id: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }).nullable(),
    actor: z.enum([
      "human",
      "assistant",
      "developer",
      "system",
      "tool",
      "unknown",
    ]),
    event_kind: z.enum([
      "thought",
      "action",
      "result",
      "message",
      "metadata",
      "compaction",
      "unknown",
    ]),
    original_type: z.string().min(1),
    original_event_id: z.string().nullable(),
    is_human_turn: z.boolean(),
    text: z.string().nullable(),
    payload_ref: SourcePointerSchema,
    parent_event_refs: z.array(EventIdSchema),
    parse_status: z.enum(["parsed", "unsupported_record", "malformed_record"]),
    parse_warnings: z.array(z.string()),
    adapter_version: z.string().min(1),
  })
  .refine(
    (event) => !event.is_human_turn || event.actor === "human",
    "Human turns require a human actor",
  );

export const LabelSchema = z.enum([
  "goal",
  "obstacle",
  "alternative",
  "decision",
  "outcome",
  "unknown",
  "not_applicable",
]);
export const EventScoreSchema = z
  .object({
    event_id: EventIdSchema,
    labels: z.array(LabelSchema).min(1),
    primary_label: LabelSchema,
    pivot_score: z.number().min(0).max(1),
    reason_codes: z.array(z.string()),
    evidence_event_ids: z.array(EventIdSchema).min(1),
    abstain_reason: z.string().nullable(),
    method_version: z.string().min(1),
  })
  .refine(
    (score) => score.labels.includes(score.primary_label),
    "Primary label must be included in labels",
  );

export const EvidenceFieldSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    value: z.string().min(1),
    evidence_event_ids: z.array(EventIdSchema).min(1),
  }),
  z.object({
    status: z.literal("inferred"),
    value: z.string().min(1),
    evidence_event_ids: z.array(EventIdSchema).min(1),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("unknown"),
    value: z.null(),
    evidence_event_ids: z.array(EventIdSchema).length(0),
  }),
]);

export const AttachmentSchema = z
  .object({
    satellite_event_id: EventIdSchema,
    pivot_event_id: EventIdSchema,
    score: z.number().min(0).max(1),
    method_version: z.string().min(1),
    evidence_event_ids: z.array(EventIdSchema).min(1),
  })
  .refine(
    (edge) => edge.satellite_event_id !== edge.pivot_event_id,
    "An event cannot attach to itself",
  );

export const PivotCardSchema = z.object({
  card_id: z.string().min(1),
  thread_id: z.string().min(1),
  pivot_event_id: EventIdSchema,
  title: EvidenceFieldSchema,
  goal: EvidenceFieldSchema,
  before_state: EvidenceFieldSchema,
  trigger: EvidenceFieldSchema,
  considered_alternatives: z.array(EvidenceFieldSchema),
  decision: EvidenceFieldSchema,
  actions: z.array(EvidenceFieldSchema),
  after_state: EvidenceFieldSchema,
  outcome: EvidenceFieldSchema,
  open_questions: z.array(EvidenceFieldSchema),
  evidence_event_ids: z.array(EventIdSchema).min(1),
  method_version: z.string().min(1),
});

export const LineageEdgeSchema = z
  .object({
    child_thread_id: z.string().min(1),
    parent_thread_id: z.string().min(1),
    relationship: z.enum([
      "fork_of",
      "spawned_by",
      "attached_to",
      "explicitly_references",
      "continuation_of",
    ]),
    status: z.enum(["observed", "inferred"]),
    evidence_event_ids: z.array(EventIdSchema).min(1),
    method_version: z.string().min(1),
  })
  .refine(
    (edge) => edge.child_thread_id !== edge.parent_thread_id,
    "Lineage cannot link a thread to itself",
  );

export const ClaimSchema = z
  .object({
    claim_id: z.string().min(1),
    text: z.string().min(1),
    evidence_event_ids: z.array(EventIdSchema).min(1),
    epistemic_status: z.enum(["observed", "inferred"]),
    support_status: z.enum(["unchecked", "supported", "rejected"]),
    verifier_version: z.string().nullable(),
  })
  .refine(
    (claim) =>
      claim.support_status === "unchecked" || claim.verifier_version !== null,
    "Checked claims require a verifier version",
  );

export const IngestBatchSchema = z.object({
  source: RawSourceSchema,
  events: z.array(NormalizedEventSchema),
  lineage: z.array(LineageEdgeSchema),
});

export type SourcePointer = z.infer<typeof SourcePointerSchema>;
export type RawSource = z.infer<typeof RawSourceSchema>;
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
export type EventScore = z.infer<typeof EventScoreSchema>;
export type EvidenceField = z.infer<typeof EvidenceFieldSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type PivotCard = z.infer<typeof PivotCardSchema>;
export type LineageEdge = z.infer<typeof LineageEdgeSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
