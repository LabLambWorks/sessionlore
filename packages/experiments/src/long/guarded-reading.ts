import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Evidence, project } from "../evidence.js";
import type { Model, ModelRequest, ModelResponse } from "../model.js";
import {
  type Chunk,
  LongOutlineSchema,
  type LongPrepared,
  NOTE,
  type Note,
  NoteSchema,
  PLAN,
  retrieveSection,
} from "./pipelines.js";
import {
  hash,
  packTokens,
  RunContext,
  readJson,
  type TokenCounter,
} from "./runtime.js";
import type { HybridIndex } from "./search.js";

export const GUARDED_READING_VERSION = "full-coverage-cached-reading-v2";
export type GuardedReadingOptions = {
  controller: Model;
  seedDirectory: string;
};
export type ReadingBatch = {
  id: string;
  chunks: Chunk[];
  source_ids: string[];
  fingerprint: string;
};

/** A typed choice can only select a still-unread, complete evidence batch. */
export class ReadingLedger {
  readonly seen = new Set<string>();
  readonly completed = new Set<string>();
  readonly events: {
    batch_id: string;
    new_source_ids: string[];
    fingerprint: string;
  }[] = [];
  constructor(
    readonly allIds: string[],
    readonly batches: ReadingBatch[],
  ) {
    if (new Set(allIds).size !== allIds.length)
      throw new Error("Duplicate corpus IDs");
    const packed = batches.flatMap((batch) => batch.source_ids);
    if (
      packed.length !== allIds.length ||
      new Set(packed).size !== allIds.length ||
      packed.some((id) => !allIds.includes(id))
    )
      throw new Error(
        "Reading batches must cover every original source exactly once",
      );
  }
  available() {
    return this.batches.filter(
      (batch) => !this.completed.has(batch.fingerprint),
    );
  }
  claim(batchId: string) {
    const batch = this.batches.find((item) => item.id === batchId);
    if (!batch || this.completed.has(batch.fingerprint))
      throw new Error("Unknown or repeated evidence batch");
    if (batch.source_ids.some((id) => this.seen.has(id)))
      throw new Error("Repeated original evidence would be read");
    return batch;
  }
  complete(batchId: string) {
    const batch = this.claim(batchId);
    batch.source_ids.forEach((id) => this.seen.add(id));
    this.completed.add(batch.fingerprint);
    this.events.push({
      batch_id: batchId,
      new_source_ids: batch.source_ids,
      fingerprint: batch.fingerprint,
    });
  }
  finish() {
    if (this.available().length || this.seen.size !== this.allIds.length)
      throw new Error("Early finish blocked: original evidence remains unread");
    return {
      covered_sources: this.seen.size,
      remaining_sources: 0,
      duplicate_reads: 0,
    };
  }
}

type CachedNote = {
  key: string;
  created_at: string;
  request: ModelRequest;
  response: ModelResponse;
  transport_error?: string;
};
export async function prepareGuardedReading(
  evidence: Evidence[],
  chunks: Chunk[],
  tokenizer: TokenCounter,
  seedDirectory: string,
) {
  const originals = new Map(evidence.map((item) => [item.id, item]));
  const cached: CachedNote[] = [];
  for (const file of await readdir(join(seedDirectory, "model-cache"))) {
    if (!file.endsWith(".json")) continue;
    const entry = await readJson<CachedNote>(
      join(seedDirectory, "model-cache", file),
    );
    if (
      entry &&
      !entry.transport_error &&
      /^tree\/leaf-\d+-of-\d+$/.test(entry.request.stage)
    )
      cached.push(entry);
  }
  const byChunk = new Map<string, CachedNote>();
  for (const chunk of chunks) {
    const expected = project(chunk.refs.map((id) => originals.get(id)!));
    const match = cached.find(
      (entry) =>
        hash((entry.request.data as { evidence: unknown }).evidence) ===
          hash(expected) &&
        entry.request.instruction === NOTE &&
        NoteSchema.safeParse(entry.response.value).success,
    );
    if (!match)
      throw new Error(
        `No exact cached source summary for ${chunk.id}; no paid replacement is allowed`,
      );
    byChunk.set(chunk.id, match);
  }
  // Whole original chunks stay intact. This grouping changes scheduling only.
  const groups = packTokens(chunks, tokenizer, 24000, (chunk) =>
    project(chunk.refs.map((id) => originals.get(id)!)),
  );
  const batches: ReadingBatch[] = groups.map((group, i) => {
    const source_ids = group.flatMap((chunk) => chunk.refs);
    return {
      id: `batch_${i + 1}`,
      chunks: group,
      source_ids,
      fingerprint: hash(source_ids),
    };
  });
  new ReadingLedger(
    evidence.map((item) => item.id),
    batches,
  );
  return { batches, byChunk };
}

export async function guardedReadingPipeline(
  ctx: RunContext,
  chunks: Chunk[],
  index: HybridIndex,
  options: GuardedReadingOptions,
): Promise<LongPrepared> {
  const { batches, byChunk } = await prepareGuardedReading(
    index.evidence,
    chunks,
    ctx.tokenizer,
    options.seedDirectory,
  );
  const ledger = new ReadingLedger(
    index.evidence.map((item) => item.id),
    batches,
  );
  const decisions = new RunContext(
    "jev-decisions",
    join(ctx.directory, "decisions"),
    ctx.cacheDirectory,
    options.controller,
    ctx.tokenizer,
    {
      inputTokens: ctx.options.inputTokens,
      maxCalls: 8,
      concurrency: 1,
      maxRepairs: 0,
      cacheDirectories: ctx.options.cacheDirectories ?? [],
    },
    ctx.progress,
  );
  const notes: Note[] = [];
  const provenance: unknown[] = [];
  await ctx.save("guarded-preflight", {
    version: GUARDED_READING_VERSION,
    corpus_sources: index.evidence.length,
    batches: batches.map(({ chunks: list, ...batch }) => ({
      ...batch,
      chunks: list.map((c) => c.id),
    })),
    cached_source_summaries: byChunk.size,
    new_source_summary_generations_allowed: 0,
  });
  while (ledger.available().length) {
    const pending = ledger.available();
    const ids = pending.map((batch) => batch.id) as [string, ...string[]];
    const choice = await decisions.ask(
      "decisions",
      `guarded/decision-${ledger.events.length + 1}`,
      z.object({ batch_id: z.enum(ids) }),
      {
        goal: "Reconstruct the entire cleaned PeekaTrack history for a first-person devlog. Prioritize important changes, failed attempts, corrections, and missing outcomes.",
        coverage: {
          covered_sources: ledger.seen.size,
          total_sources: index.evidence.length,
          remaining_batches: pending.length,
        },
        unresolved: [...new Set(notes.flatMap((note) => note.unresolved))],
        completed_batches: ledger.events.map((event) => event.batch_id),
        candidates: pending.map((batch) => ({
          batch_id: batch.id,
          original_source_count: batch.source_ids.length,
          // Complete cached summaries are navigation metadata. The full facts and
          // their original-source links are loaded only when the batch is selected.
          navigation: batch.chunks.map((chunk) => ({
            chunk: chunk.id,
            thread: chunk.thread_id,
            summary: NoteSchema.parse(byChunk.get(chunk.id)!.response.value)
              .summary,
          })),
        })),
      },
      "Select exactly one of the available unread evidence batches. Prioritize evidence that advances outstanding gaps. No search query, delegation, or finish action is available. Code enforces complete coverage and preserves unresolved questions; selecting a batch never means its reported outcome is true.",
    );
    const batch = ledger.claim(choice.batch_id);
    for (const chunk of batch.chunks) {
      const seed = byChunk.get(chunk.id)!;
      const evidence = chunk.refs.map((id) => index.byId.get(id)!);
      const note = await ctx.ask(
        "summarize",
        seed.request.stage,
        NoteSchema,
        { evidence: project(evidence) },
        NOTE,
      );
      notes.push(note);
      for (const id of chunk.refs) {
        ctx.readSources.add(id);
        ctx.rawReadSources.add(id);
      }
      provenance.push({
        chunk: chunk.id,
        source_ids: chunk.refs,
        original_cache_key: seed.key,
        source_directory: options.seedDirectory,
        original_request_sha256: hash(seed.request),
        note_sha256: hash(note),
      });
    }
    ledger.complete(batch.id);
    await ctx.save("guarded-reading-ledger", {
      version: GUARDED_READING_VERSION,
      covered_sources: ledger.seen.size,
      remaining_sources: index.evidence.length - ledger.seen.size,
      events: ledger.events,
    });
    await ctx.save("guarded-source-provenance", provenance);
  }
  const coverage = ledger.finish();
  const unresolved = [...new Set(notes.flatMap((note) => note.unresolved))];
  await ctx.save("guarded-completion", {
    ...coverage,
    complete_history_processed: true,
    all_gaps_resolved: false,
    unresolved,
    meaning:
      "All retained original records have been processed through exact cached summaries. Missing or contradictory outcomes remain unresolved; coverage is not proof of semantic recall.",
  });
  // One writing plan from the ordered notes; no recursive note-merging loop.
  const outline = await ctx.ask(
    "outline",
    "guarded/outline",
    LongOutlineSchema,
    { notes, coverage, unresolved },
    PLAN,
  );
  await ctx.save("outline", outline);
  const sections = [];
  for (const [i, section] of outline.sections.entries())
    sections.push(
      await retrieveSection(ctx, index, section, `retrieval/section-${i + 1}`),
    );
  return { outline, sections };
}
