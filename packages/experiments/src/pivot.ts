import type { Context } from "./context.js";
import {
  blocks,
  project,
  referencedIds,
  SearchIndex,
  unique,
} from "./evidence.js";
import {
  type Card,
  CardSchema,
  LinkSchema,
  type Score,
  ScoresSchema,
  SegmentsSchema,
} from "./schema.js";
import { type Prepared, pack } from "./shared.js";

export async function pivot(ctx: Context): Promise<Prepared> {
  const scores: Score[] = [];
  for (const [i, block] of blocks(
    ctx.corpus.evidence,
    ctx.options.block_chars,
  ).entries()) {
    const result = await ctx.ask(
      "score",
      `pivot/score-${i + 1}`,
      ScoresSchema,
      { evidence: project(block) },
      "Score EACH source ID exactly once for retrospective narrative relevance (0 to 1). This is NOT confidence or a correctness probability. Apply multiple labels if appropriate. Explain each score using cited evidence; do not invent a pivot just to fill a label.",
      (result) => {
        const ids = result.scores.map((score) => score.id);
        if (
          ids.length !== block.length ||
          unique(ids).length !== ids.length ||
          block.some((item) => !ids.includes(item.id))
        )
          throw new Error("Scores must cover each input ID exactly once.");
      },
    );
    scores.push(...result.scores);
  }
  await ctx.save("scores", scores);
  const cards: Card[] = [];
  const attachments: { source_id: string; pivot_id: string; method: string }[] =
    [];
  const scoreMap = new Map(scores.map((score) => [score.id, score]));
  const threadIds = unique(
    ctx.corpus.evidence.map(
      (item) => item.thread_id ?? `artifact:${item.artifact_id}`,
    ),
  );
  for (const threadId of threadIds) {
    const items = ctx.corpus.evidence.filter(
      (item) => (item.thread_id ?? `artifact:${item.artifact_id}`) === threadId,
    );
    let pivots = items.filter(
      (item) =>
        (scoreMap.get(item.id)?.relevance ?? 0) >= ctx.options.pivot_threshold,
    );
    if (!pivots.length && items.length) {
      pivots = [
        [...items].sort(
          (a, b) =>
            (scoreMap.get(b.id)?.relevance ?? 0) -
            (scoreMap.get(a.id)?.relevance ?? 0),
        )[0]!,
      ];
      ctx.warnings.push(
        `No score met the threshold in ${threadId}; highest-ranked source retained as a fallback anchor.`,
      );
    }
    const positions = new Map(items.map((item, i) => [item.id, i]));
    const groups = new Map(pivots.map((item) => [item.id, [] as typeof items]));
    for (const item of items) {
      const anchor = [...pivots].sort(
        (a, b) =>
          Math.abs(positions.get(a.id)! - positions.get(item.id)!) -
          Math.abs(positions.get(b.id)! - positions.get(item.id)!),
      )[0]!;
      groups.get(anchor.id)!.push(item);
      if (item.id !== anchor.id)
        attachments.push({
          source_id: item.id,
          pivot_id: anchor.id,
          method: "nearest-source-within-thread; ties prefer earlier",
        });
    }
    for (const [pivotId, group] of groups) {
      const card = await ctx.ask(
        "card",
        `pivot/card-${cards.length + 1}`,
        CardSchema,
        { pivot_id: pivotId, evidence: project(group) },
        "Make a pivot card from this anchor and its reversibly attached neighbors. Treat the score and attachment as proposals. Use null for unsupported fields; a trigger requires explicit evidence or an inferred qualifier. Do not turn adjacency into causality. Keep alternatives, reversal and open outcomes visible. Cite each populated field.",
      );
      cards.push({
        id: `card-${cards.length + 1}`,
        thread_id: threadId,
        pivot_id: pivotId,
        ...card,
        refs: group.map((item) => item.id),
      });
    }
  }
  await ctx.save("attachments", attachments);
  await ctx.save("cards", cards);

  const links: {
    child: string;
    parent: string;
    status: string;
    reason: string;
    source_refs: string[];
    event_ids: string[];
  }[] = ctx.corpus.lineage.map((edge) => ({
    child: edge.child_thread_id,
    parent: edge.parent_thread_id,
    status: "observed",
    reason: edge.relationship,
    source_refs: [],
    event_ids: edge.evidence_event_ids,
  }));
  const threads = threadIds.filter((id) => !id.startsWith("artifact:"));
  const descriptions = threads.map((id) => ({
    id,
    cards: cards.filter((card) => card.thread_id === id),
    text: ctx.corpus.evidence
      .filter((item) => item.thread_id === id)
      .map((item) => item.text)
      .join("\n"),
  }));
  for (const [i, child] of descriptions.entries()) {
    if (!i || links.some((link) => link.child === child.id)) continue;
    const candidates = new SearchIndex(
      descriptions.slice(0, i),
      (item) => item.text,
    )
      .search(child.text, 3)
      .map((hit) => ({ thread_id: hit.item.id, cards: hit.item.cards }));
    if (!candidates.length) continue;
    const proposal = await ctx.ask(
      "link",
      `pivot/link-${i + 1}`,
      LinkSchema,
      { child: { thread_id: child.id, cards: child.cards }, candidates },
      "Decide whether this thread explicitly continues ONE candidate. Shared vocabulary alone is insufficient. Return null when uncertain or independent. Cite evidence. This is an experimental semantic continuation proposal, not official ancestry.",
      (proposal) => {
        if (
          proposal.parent_thread_id &&
          !candidates.some(
            (candidate) => candidate.thread_id === proposal.parent_thread_id,
          )
        )
          throw new Error("Parent must be a supplied candidate or null.");
      },
    );
    if (proposal.parent_thread_id)
      links.push({
        child: child.id,
        parent: proposal.parent_thread_id,
        status: "inferred",
        reason: proposal.reason,
        source_refs: proposal.refs,
        event_ids: [],
      });
  }
  await ctx.save("thread-links", {
    links,
    official_lineage: ctx.corpus.lineage,
    calibrated: false,
  });
  // Stable topological thread order. Preserve every branch; never merge thread identities.
  const orderedThreads: string[] = [];
  const remaining = new Set(threadIds);
  while (remaining.size) {
    let next = [...remaining].find(
      (id) =>
        !links.some((link) => link.child === id && remaining.has(link.parent)),
    );
    if (!next) {
      next = remaining.values().next().value!;
      ctx.warnings.push(
        "Lineage cycle detected; source order breaks the ordering tie. Edges remain in thread-links.json.",
      );
    }
    orderedThreads.push(next);
    remaining.delete(next);
  }
  const ordered = orderedThreads.flatMap((id) =>
    cards.filter((card) => card.thread_id === id),
  );
  await ctx.save("ordered-cards", ordered);
  const sections: Prepared["sections"] = [];
  let title = "Engineering session narrative";
  for (const [i, group] of pack(
    ordered,
    ctx.options.context_chars * 0.4,
  ).entries()) {
    const result = await ctx.ask(
      "segment",
      `pivot/segment-${i + 1}`,
      SegmentsSchema,
      { cards: group },
      "Cut this ordered card sequence into contiguous narrative sections. Every card must appear exactly once, in its existing order. Never conflate inferred continuation with causation. Return card IDs, not source IDs.",
      (result) => {
        if (
          JSON.stringify(
            result.segments.flatMap((segment) => segment.card_ids),
          ) !== JSON.stringify(group.map((card) => card.id))
        )
          throw new Error(
            "Segments must partition the card sequence in order, without omissions or duplicates.",
          );
      },
    );
    title = result.title;
    for (const segment of result.segments) {
      const selected = group.filter((card) =>
        segment.card_ids.includes(card.id),
      );
      sections.push({
        plan: {
          heading: segment.heading,
          focus: segment.focus,
          refs: unique(selected.flatMap((card) => referencedIds(card))),
          queries: [],
        },
        evidence: selected,
      });
    }
  }
  await ctx.save("outline", {
    title,
    sections: sections.map((section) => section.plan),
  });
  return { title, sections };
}
