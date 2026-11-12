import type { Context } from "./context.js";
import {
  type Evidence,
  project,
  SearchIndex,
  tokens,
  unique,
} from "./evidence.js";
import { type Outline, OutlineSchema } from "./schema.js";
import { OUTLINE_INSTRUCTION, type Prepared, pack } from "./shared.js";

export async function retrieval(ctx: Context): Promise<Prepared> {
  const index = new SearchIndex(ctx.corpus.evidence, (item) => item.text);
  const catalogue = ctx.corpus.evidence.map((item) => ({
    id: item.id,
    thread_id: item.thread_id,
    kind: item.kind,
    timestamp: item.timestamp,
    preview: item.text.slice(0, 200),
    keywords: unique(tokens(item.text)).slice(0, 24),
  }));
  await ctx.save("search-index", {
    method: "BM25",
    k1: 1.2,
    b: 0.75,
    catalogue,
  });
  let outline: Outline | null = null;
  for (const [i, page] of pack(
    catalogue,
    ctx.options.context_chars * 0.35,
  ).entries()) {
    outline = await ctx.ask(
      "discover",
      `retrieval/discover-${i + 1}`,
      OutlineSchema,
      { catalogue: page, previous_outline: outline },
      `${OUTLINE_INSTRUCTION} These are searchable previews, not full evidence. Propose or update an outline and specific search queries for each section. Preserve important topics from earlier catalogue pages. You will retrieve full sources next.`,
    );
  }
  if (!outline) throw new Error("No sources to index.");
  await ctx.save("initial-outline", outline);
  const trace: unknown[] = [];
  const retrieved = new Map<string, Evidence>();
  const retrieve = (current: Outline, round: number) => {
    const selected = new Set<string>();
    for (const section of current.sections) {
      for (const ref of section.refs) {
        selected.add(ref);
        retrieved.set(ref, ctx.byId.get(ref)!);
      }
      for (const query of unique([
        `${section.heading} ${section.focus}`,
        ...section.queries,
      ])) {
        const hits = index.search(query, ctx.options.retrieval_k);
        trace.push({
          round,
          section: section.heading,
          query,
          hits: hits.map((hit) => ({ id: hit.item.id, score: hit.score })),
        });
        for (const hit of hits) {
          selected.add(hit.item.id);
          retrieved.set(hit.item.id, hit.item);
        }
      }
    }
    return [...selected];
  };
  for (let round = 1; round <= ctx.options.retrieval_rounds; round++) {
    const refs = retrieve(outline, round);
    // Revise on bounded pages of complete sources. Keep a compact outline between pages.
    for (const [i, page] of pack(
      ctx.projection(refs),
      ctx.options.context_chars * 0.4,
    ).entries()) {
      outline = await ctx.ask(
        "revise",
        `retrieval/revise-${round}-${i + 1}`,
        OutlineSchema,
        { outline, evidence: page },
        `${OUTLINE_INSTRUCTION} Revise the outline using actual evidence. Remove unsupported connections, keep unresolved contradictions, and propose follow-up queries for missing context. Keep relevant earlier refs. This is retrieval-driven writing; do not create pivot cards or workstream assignments.`,
      );
    }
  }
  // Execute final revised queries too; newly proposed sections must receive evidence.
  retrieve(outline, ctx.options.retrieval_rounds + 1);
  await ctx.save("retrieval-trace", trace);
  await ctx.save("retrieved-evidence", [...retrieved.keys()]);
  await ctx.save("outline", outline);
  return {
    title: outline.title,
    sections: outline.sections.map((plan) => {
      const ids = unique([
        ...plan.refs,
        ...unique([`${plan.heading} ${plan.focus}`, ...plan.queries]).flatMap(
          (query) =>
            index
              .search(query, ctx.options.retrieval_k)
              .map((hit) => hit.item.id),
        ),
      ]);
      return { plan, evidence: ctx.projection(ids) };
    }),
  };
}
