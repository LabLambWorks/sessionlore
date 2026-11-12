import { z } from "zod";

export const APPROACHES = [
  "direct",
  "hierarchical",
  "pivot",
  "workstream",
  "retrieval",
  "artifact",
] as const;
export type Approach = (typeof APPROACHES)[number];
export const APPROACH_NAMES: Record<Approach, string> = {
  direct: "A. Direct narrative baseline",
  hierarchical: "B. Hierarchical summarization",
  pivot: "C. Pivot-first pipeline",
  workstream: "D. Workstream-first pipeline",
  retrieval: "E. Retrieval-driven writing",
  artifact: "F. Artifact-anchored reconstruction",
};

export const Refs = z.array(z.string().min(1)).min(1);
export const StatementSchema = z.object({
  text: z.string().min(1),
  refs: Refs,
  status: z.enum(["observed", "inferred"]),
});
export type Statement = z.infer<typeof StatementSchema>;
export const SummarySchema = z.object({
  summary: z.string().min(1),
  facts: z.array(StatementSchema).min(1),
});
export type Summary = z.infer<typeof SummarySchema>;
export const SectionSchema = z.object({
  heading: z.string().min(1),
  focus: z.string().min(1),
  refs: Refs,
  queries: z.array(z.string().min(1)),
});
export type Section = z.infer<typeof SectionSchema>;
export const OutlineSchema = z.object({
  title: z.string().min(1),
  sections: z.array(SectionSchema).min(1).max(8),
});
export type Outline = z.infer<typeof OutlineSchema>;
export const WritingSchema = z.object({
  claims: z.array(StatementSchema).min(1),
});
export const ScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        id: z.string(),
        labels: z
          .array(
            z.enum([
              "goal",
              "obstacle",
              "alternative",
              "decision",
              "outcome",
              "unknown",
              "not_applicable",
            ]),
          )
          .min(1),
        relevance: z.number().min(0).max(1),
        reason: z.string().min(1),
        refs: Refs,
      }),
    )
    .min(1),
});
export type Score = z.infer<typeof ScoresSchema>["scores"][number];
export const CardSchema = z.object({
  title: z.string().min(1),
  goal: StatementSchema.nullable(),
  before: StatementSchema.nullable(),
  trigger: StatementSchema.nullable(),
  alternatives: z.array(StatementSchema),
  decision: StatementSchema.nullable(),
  after: StatementSchema.nullable(),
  outcome: StatementSchema.nullable(),
  open_questions: z.array(StatementSchema),
});
export type Card = z.infer<typeof CardSchema> & {
  id: string;
  thread_id: string;
  pivot_id: string;
  refs: string[];
};
export const LinkSchema = z.object({
  parent_thread_id: z.string().nullable(),
  reason: z.string(),
  refs: Refs,
});
export const SegmentsSchema = z.object({
  title: z.string().min(1),
  segments: z
    .array(
      z.object({
        heading: z.string().min(1),
        focus: z.string().min(1),
        card_ids: Refs,
      }),
    )
    .min(1)
    .max(8),
});
export const AttemptsSchema = z.object({
  attempts: z
    .array(
      z.object({
        goal: z.string().min(1),
        summary: z.string().min(1),
        refs: Refs,
      }),
    )
    .min(1),
});
export type Attempt = z.infer<typeof AttemptsSchema>["attempts"][number] & {
  id: string;
  thread_id: string;
};
export const MembershipSchema = z.object({
  group_ids: z.array(z.string()),
  create_new: z.boolean(),
  reason: z.string().min(1),
});
export type Workstream = {
  id: string;
  goal: string;
  attempt_ids: string[];
  refs: string[];
};
export const VerifySchema = z.object({
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  reason: z.string().min(1),
});
export type Verdict = z.infer<typeof VerifySchema> & {
  claim_id: string;
  checked_refs: string[];
};

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["commit", "diff", "pr", "issue", "test"]),
    title: z.string().min(1),
    text: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }).nullable(),
    uri: z.string().nullable(),
    paths: z.array(z.string()),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export const ArtifactFileSchema = z
  .object({ version: z.literal(1), artifacts: z.array(ArtifactSchema) })
  .strict();

export const OptionsSchema = z.object({
  since: z.iso.datetime({ offset: true }).nullable().default(null),
  until: z.iso.datetime({ offset: true }).nullable().default(null),
  block_chars: z.number().int().min(500).default(10000),
  context_chars: z.number().int().min(8000).default(120000),
  target_words: z.number().int().min(100).max(10000).default(700),
  max_calls: z.number().int().positive().default(250),
  retrieval_k: z.number().int().min(1).max(50).default(6),
  retrieval_rounds: z.number().int().min(1).max(5).default(2),
  pivot_threshold: z.number().min(0).max(1).default(0.6),
});
export type PipelineOptions = z.infer<typeof OptionsSchema>;
export type Material = Summary & {
  id: string;
  refs: string[];
  child_ids?: string[];
};
