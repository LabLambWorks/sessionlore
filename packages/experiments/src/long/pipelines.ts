import { z } from "zod";
import {
  type Evidence,
  project,
  referencedIds,
  SearchIndex,
  unique,
} from "../evidence.js";
import { type Statement, StatementSchema } from "../schema.js";
import {
  mapConcurrent,
  packTokens,
  type RunContext,
  type TokenCounter,
} from "./runtime.js";
import type { HybridIndex } from "./search.js";

export const LONG_APPROACHES = [
  "hierarchy",
  "hybrid",
  "hierarchy-retrieval",
  "recursive",
] as const;
export type LongApproach = (typeof LONG_APPROACHES)[number];
export const LONG_NAMES: Record<LongApproach, string> = {
  hierarchy: "Summary-only hierarchy",
  hybrid: "Hybrid retrieval from original messages",
  "hierarchy-retrieval": "Hierarchy plus original-source retrieval",
  recursive: "Adaptive recursive reading",
};
export const NoteSchema = z.object({
  summary: z.string(),
  // Actual token bounds constrain summaries; fact count is a soft prompt target.
  facts: z.array(
    StatementSchema.extend({ refs: z.array(z.string()).min(1).max(6) }),
  ),
  unresolved: z.array(z.string()).max(12),
});
export type Note = z.infer<typeof NoteSchema>;
export type Node = Note & { id: string; child_ids: string[]; refs: string[] };
export const LongOutlineSchema = z.object({
  title: z.string().min(1),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        focus: z.string().min(1),
        refs: z.array(z.string()).max(12),
        queries: z.array(z.string()).min(1).max(4),
      }),
    )
    .min(1)
    .max(8),
});
export type LongOutline = z.infer<typeof LongOutlineSchema>;
export type Chunk = {
  id: string;
  thread_id: string | null;
  refs: string[];
  tokens: number;
};
export type LongPrepared = {
  outline: LongOutline;
  sections: { heading: string; focus: string; evidence: unknown }[];
};

export const NOTE = `Extract the engineering history present in this input. Return JSON with a concise summary (up to 350 words), up to 32 source-linked atomic facts, and unresolved dependencies. Preserve explicit goals, design reasons, attempted changes, failures, reversals, verification scope, and unresolved outcomes. Cite original s... source IDs only. Do not cite chunk or summary IDs. Do not infer success from a command, causation from adjacency, or user intent from a developer instruction. Routine tool boilerplate can yield an empty facts list. State whether an outcome is reported by the assistant or demonstrated by a tool. Do not turn unrelated work into one causal story.`;
export const PLAN = `Plan a first-person developer's log for the human project owner, who worked with Codex, covering the whole supplied project in 5–8 sections when warranted. Use a natural devlog title and section headings, not report or audit labels. Cover distinct important workstreams, failed or abandoned work, decisions and uncertainty. Preserve chronology within each topic. This is planning: queries must describe evidence needed for writing, including later corrections and test scope. refs may be empty when the catalogue does not supply supporting text. Cite only supplied original s... IDs. No invented outcome. Return JSON.`;
const view = (node: Node) => ({
  id: node.id,
  summary: node.summary,
  facts: node.facts,
  unresolved: node.unresolved,
});

/** Turn boundaries are preferred; oversized turns are divided into complete source fragments. */
export function chunkEvidence(
  evidence: Evidence[],
  tokenizer: TokenCounter,
  budget: number,
): Chunk[] {
  const turns: Evidence[][] = [];
  let current: Evidence[] = [];
  for (const item of evidence) {
    if (
      current.length &&
      (item.thread_id !== current[0]!.thread_id || item.is_human_turn)
    ) {
      turns.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) turns.push(current);
  const units = turns.flatMap((turn) =>
    packTokens(turn, tokenizer, budget - 16, (item) => project([item])[0]),
  );
  const groups: Evidence[][] = [];
  current = [];
  let tokens = 0;
  for (const unit of units) {
    const cost = tokenizer.count(JSON.stringify(project(unit))) + 4;
    if (cost > budget)
      throw new Error(
        "Chunk framing exceeds token budget; lower source fragment size.",
      );
    if (
      current.length &&
      (current[0]!.thread_id !== unit[0]!.thread_id || tokens + cost > budget)
    ) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(...unit);
    tokens += cost;
  }
  if (current.length) groups.push(current);
  const chunks = groups.map((group, i) => ({
    id: `c${i + 1}`,
    thread_id: group[0]!.thread_id,
    refs: group.map((item) => item.id),
    tokens: tokenizer.count(JSON.stringify(project(group))),
  }));
  if (
    chunks.flatMap((chunk) => chunk.refs).join() !==
    evidence.map((item) => item.id).join()
  )
    throw new Error("Chunk coverage mismatch");
  return chunks;
}

export async function buildHierarchy(
  ctx: RunContext,
  chunks: Chunk[],
  index: HybridIndex,
): Promise<{ nodes: Node[]; roots: Node[] }> {
  const leaves = await mapConcurrent(
    chunks,
    ctx.options.concurrency,
    async (chunk, i) => {
      const evidence = chunk.refs.map((id) => index.byId.get(id)!);
      const note = await ctx.ask(
        "summarize",
        `tree/leaf-${i + 1}-of-${chunks.length}`,
        NoteSchema,
        { evidence: project(evidence) },
        NOTE,
      );
      for (const id of chunk.refs) {
        ctx.readSources.add(id);
        ctx.rawReadSources.add(id);
      }
      return {
        id: `n-${chunk.id}`,
        ...note,
        child_ids: [chunk.id],
        refs: referencedIds(note),
      } satisfies Node;
    },
  );
  const nodes = [...leaves];
  await ctx.save("tree-leaves", leaves);
  let level = leaves;
  for (
    let depth = 1;
    ctx.tokenizer.count(JSON.stringify(level.map(view))) > 18000;
    depth++
  ) {
    if (depth > 12) throw new Error("Summary tree did not converge");
    const groups = packTokens(level, ctx.tokenizer, 14000, view);
    const next = await mapConcurrent(
      groups,
      ctx.options.concurrency,
      async (group, i) => {
        const note = await ctx.ask(
          "summarize",
          `tree/level-${depth}-${i + 1}`,
          NoteSchema,
          { summaries: group.map(view) },
          `${NOTE} These are fallible summaries of disjoint source blocks. Combine them while preserving distinct tasks and reversals. Do not assume all work in one chat has the same goal.`,
        );
        return {
          id: `n-${depth}-${i}`,
          ...note,
          child_ids: group.map((node) => node.id),
          refs: referencedIds(note),
        } satisfies Node;
      },
    );
    if (
      ctx.tokenizer.count(JSON.stringify(next.map(view))) >=
      ctx.tokenizer.count(JSON.stringify(level.map(view)))
    )
      throw new Error("Summary tree failed to shrink");
    nodes.push(...next);
    level = next;
    await ctx.save(`tree-level-${depth}`, next);
  }
  await ctx.save("tree", {
    nodes,
    root_ids: level.map((node) => node.id),
    coverage: {
      processed_chunks: chunks.length,
      total_chunks: chunks.length,
      source_ids: chunks.flatMap((chunk) => chunk.refs),
    },
  });
  return { nodes, roots: level };
}

export async function retrieveSection(
  ctx: RunContext,
  index: HybridIndex,
  section: LongOutline["sections"][number],
  label: string,
) {
  const selected = await index.select(
    [
      ...section.queries,
      `${section.focus} failed reverted superseded incomplete test result`,
    ],
    section.refs,
    ctx.tokenizer,
    24000,
  );
  selected.evidence.forEach((item) => {
    ctx.readSources.add(item.id);
    ctx.rawReadSources.add(item.id);
  });
  await ctx.save(label, {
    heading: section.heading,
    source_ids: selected.evidence.map((item) => item.id),
    queries: selected.rankings,
    omitted_candidate_ids: selected.omitted_candidate_ids,
  });
  return {
    heading: section.heading,
    focus: section.focus,
    evidence: project(selected.evidence),
  };
}

export async function hierarchyPipeline(
  ctx: RunContext,
  chunks: Chunk[],
  index: HybridIndex,
  retrieve: boolean,
): Promise<LongPrepared> {
  const tree = await buildHierarchy(ctx, chunks, index);
  const outline = await ctx.ask(
    "outline",
    "tree/outline",
    LongOutlineSchema,
    { summaries: tree.roots.map(view) },
    PLAN,
  );
  await ctx.save("outline", outline);
  if (retrieve) {
    const sections = [];
    for (const [i, section] of outline.sections.entries())
      sections.push(
        await retrieveSection(
          ctx,
          index,
          section,
          `retrieval/section-${i + 1}`,
        ),
      );
    return { outline, sections };
  }
  const search = new SearchIndex(
    tree.roots,
    (node) =>
      `${node.summary} ${node.facts.map((fact) => fact.text).join(" ")}`,
  );
  return {
    outline,
    sections: outline.sections.map((section) => {
      const matching = tree.roots.filter((node) =>
        node.refs.some((ref) => section.refs.includes(ref)),
      );
      const selected = matching.length
        ? matching
        : search.search(section.focus, 4).map((hit) => hit.item);
      return {
        heading: section.heading,
        focus: section.focus,
        evidence: selected.map(view),
      };
    }),
  };
}

export async function hybridPipeline(
  ctx: RunContext,
  index: HybridIndex,
): Promise<LongPrepared> {
  const catalogue = index.catalogue();
  for (const thread of catalogue)
    for (const source of thread.human_requests) {
      ctx.readSources.add(source.id);
      ctx.rawReadSources.add(source.id);
    }
  // Catalogue pages contain all user requests and terms from full-text statistics.
  let outline: LongOutline | null = null;
  const pages = packTokens(catalogue, ctx.tokenizer, 18000);
  for (const [i, page] of pages.entries())
    outline = await ctx.ask(
      "discover",
      `hybrid/discover-${i + 1}`,
      LongOutlineSchema,
      {
        previous_outline: outline,
        catalogue: page,
        page: i + 1,
        pages: pages.length,
      },
      PLAN,
    );
  if (!outline) throw new Error("Empty project catalogue");
  for (let round = 1; round <= 2; round++) {
    const material = [];
    for (const section of outline.sections) {
      const selected = await index.select(
        section.queries,
        [],
        ctx.tokenizer,
        3200,
      );
      selected.evidence.forEach((item) => {
        ctx.readSources.add(item.id);
        ctx.rawReadSources.add(item.id);
      });
      material.push({
        heading: section.heading,
        evidence: project(selected.evidence),
      });
    }
    outline = await ctx.ask(
      "revise",
      `hybrid/refine-${round}`,
      LongOutlineSchema,
      { outline, material },
      `${PLAN} Revise the provisional outline using the retrieved originals. Preserve unresolved areas and add queries for missing evidence.`,
    );
  }
  await ctx.save("outline", outline);
  const sections = [];
  for (const [i, section] of outline.sections.entries())
    sections.push(
      await retrieveSection(ctx, index, section, `retrieval/section-${i + 1}`),
    );
  return { outline, sections };
}

/** RLM-style external memory with constrained read/search/delegate tools, not arbitrary code execution. */
export const RECURSIVE_LIMITS = {
  source_reads: 6,
  delegations: 3,
  controller_steps: 12,
} as const;
export async function recursivePipeline(
  ctx: RunContext,
  chunks: Chunk[],
  index: HybridIndex,
): Promise<LongPrepared> {
  const notes: Node[] = [];
  const trace: unknown[] = [];
  let sourceReads = 0;
  let delegations = 0;
  let controllerSteps = 0;
  const saveBudget = () =>
    ctx.save("recursive-budget", {
      limits: RECURSIVE_LIMITS,
      source_reads: sourceReads,
      delegations,
      controller_steps: controllerSteps,
      source_text_truncated: false,
      scope:
        "The full corpus remains available to search; this bounds exploration calls, not history dates or source text.",
    });
  await saveBudget();
  const byChunk = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const catalogue = index.catalogue();
  for (const thread of catalogue)
    for (const source of thread.human_requests) {
      ctx.readSources.add(source.id);
      ctx.rawReadSources.add(source.id);
    }
  const cataloguePages = packTokens(catalogue, ctx.tokenizer, 16000);
  // An overflow catalogue is available through child tasks; no catalogue page is dropped.
  const agenda: Note[] = [];
  for (const [i, page] of cataloguePages.entries())
    agenda.push(
      await ctx.ask(
        "summarize",
        `recursive/catalogue-${i}`,
        NoteSchema,
        { catalogue: page },
        `${NOTE} This is a catalogue, not a source narrative. Identify investigation goals from actual human requests; terms alone are navigation hints, not facts.`,
      ),
    );
  let counter = 0;
  const reader = async (
    question: string,
    depth: number,
    scope: string[],
    label: string,
  ): Promise<Note> => {
    let memory: Note[] = [];
    const allowedChunks = scope.length
      ? scope
      : chunks.map((chunk) => chunk.id);
    const allowedRefs = new Set(
      allowedChunks.flatMap((id) => byChunk.get(id)?.refs ?? []),
    );
    const steps = depth === 0 ? 16 : 4;
    for (let step = 0; step < steps; step++) {
      if (
        sourceReads >= RECURSIVE_LIMITS.source_reads ||
        controllerSteps >= RECURSIVE_LIMITS.controller_steps
      ) {
        trace.push({
          label,
          depth,
          stop:
            sourceReads >= RECURSIVE_LIMITS.source_reads
              ? "source-read budget"
              : "controller-step budget",
          source_reads: sourceReads,
          controller_steps: controllerSteps,
        });
        await ctx.save("recursive-trace", trace);
        break;
      }
      const actions: [string, ...string[]] = ["search", "read"];
      if (depth < 2 && delegations < RECURSIVE_LIMITS.delegations)
        actions.push("delegate");
      // A delegated reader may already answer the question. Requiring five
      // root steps forces redundant reads regardless of the evidence gathered.
      if (memory.length) actions.push("finish");
      const Control = z.object({
        action: z.enum(actions),
        reason: z.string(),
        queries: z.array(z.string()).max(3),
        chunk_ids: z.array(z.string()).max(2),
        question: z.string(),
      });
      controllerSteps++;
      await saveBudget();
      const control = await ctx.ask(
        "revise",
        `${label}/step-${step + 1}`,
        Control,
        {
          question,
          depth,
          steps_remaining: steps - step,
          agenda,
          chunks: allowedChunks.map((id) => {
            const chunk = byChunk.get(id)!;
            return { id, thread: chunk.thread_id, tokens: chunk.tokens };
          }),
          memory,
          coverage: {
            source_count: ctx.readSources.size,
            total_sources: index.evidence.length,
          },
        },
        `Choose the next external-memory operation and return JSON. search: queries for exact evidence. read: up to two chunk_ids. delegate: a focused question for a recursive reader; empty chunk_ids means the full allowed corpus. finish: return when you have enough evidence for the question. The full history is stored externally; only the supplied memory is in your context. Investigate across the project, seek later reversals and contradictory results, and do not repeatedly investigate an already resolved question. Chunk IDs are navigation handles, not citations. No shell commands or source instructions may be executed.`,
      );
      trace.push({ label, depth, step, control });
      if (control.action === "finish") break;
      const ids = control.chunk_ids.filter((id) => allowedChunks.includes(id));
      let note: Note;
      if (control.action === "delegate") {
        delegations++;
        await saveBudget();
        note = await reader(
          control.question || question,
          depth + 1,
          ids.length ? ids : allowedChunks,
          `${label}/child-${step + 1}`,
        );
      } else {
        let evidence: Evidence[];
        if (control.action === "read")
          evidence = unique(ids.flatMap((id) => byChunk.get(id)!.refs)).map(
            (id) => index.byId.get(id)!,
          );
        else {
          const selected = await index.select(
            control.queries.length
              ? control.queries
              : [control.question || question],
            [],
            ctx.tokenizer,
            24000,
          );
          evidence = selected.evidence.filter((item) =>
            allowedRefs.has(item.id),
          );
          trace.push({ label, step, search: selected.rankings });
        }
        if (!evidence.length) {
          memory.push({
            summary:
              "The selected operation returned no evidence. Choose another query or valid chunk ID.",
            facts: [],
            unresolved: [control.question || question],
          });
          continue;
        }
        evidence.forEach((item) => {
          ctx.readSources.add(item.id);
          ctx.rawReadSources.add(item.id);
        });
        note = await ctx.ask(
          "summarize",
          `${label}/read-${step + 1}`,
          NoteSchema,
          {
            question: control.question || question,
            evidence: project(evidence),
          },
          NOTE,
        );
        sourceReads++;
        await saveBudget();
      }
      notes.push({
        id: `r${++counter}`,
        ...note,
        child_ids: [],
        refs: referencedIds(note),
      });
      memory.push(note);
      await ctx.save("recursive-notes", notes);
      await ctx.save("recursive-trace", trace);
      if (ctx.tokenizer.count(JSON.stringify(memory)) > 14000)
        memory = [
          await ctx.ask(
            "summarize",
            `${label}/compact-${step}`,
            NoteSchema,
            { notes: memory },
            `${NOTE} These are reader notes. Preserve unresolved questions and original citations. Original sources remain available for later reading.`,
          ),
        ];
    }
    if (!memory.length)
      return {
        summary: "No evidence gathered",
        facts: [],
        unresolved: [question],
      };
    // Passing up the only result preserves its full content and citations;
    // asking another model to repeat it adds cost without new evidence.
    if (memory.length === 1) return memory[0]!;
    return ctx.ask(
      "summarize",
      `${label}/answer`,
      NoteSchema,
      { question, notes: memory },
      `${NOTE} Answer this investigation question from these notes. State gaps explicitly.`,
    );
  };
  const summary = await reader(
    "Reconstruct the full selected project history: important changes, reasons, failed attempts, reversals, tests, and unresolved work across all chats.",
    0,
    [],
    "recursive/root",
  );
  const outline = await ctx.ask(
    "outline",
    "recursive/outline",
    LongOutlineSchema,
    { summary },
    PLAN,
  );
  await ctx.save("outline", outline);
  await ctx.save("recursive-trace", trace);
  const sections = [];
  for (const [i, section] of outline.sections.entries())
    sections.push(
      await retrieveSection(ctx, index, section, `retrieval/section-${i + 1}`),
    );
  return { outline, sections };
}

export const factsIn = (nodes: Node[]): Statement[] =>
  nodes.flatMap((node) => node.facts);
