import { type Context, PipelineLimit } from "./context.js";
import {
  blocks,
  type Evidence,
  project,
  referencedIds,
  unique,
} from "./evidence.js";
import {
  type Material,
  OutlineSchema,
  type Section,
  SummarySchema,
} from "./schema.js";

export type Prepared = {
  title: string;
  sections: { plan: Section; evidence: unknown }[];
};
export const SUMMARY_INSTRUCTION =
  "Summarize every supplied block in at most 120 words and at most eight atomic facts. Preserve important decisions, failed attempts, reversals, test scope, and unresolved outcomes. Keep source refs on each fact. Do not score pivots or group by semantic task. The summary is a lossy representation; do not invent missing detail.";
export const OUTLINE_INSTRUCTION =
  "Plan a readable engineering devlog in one to eight sections. Each section needs a heading, focus, and relevant source refs from this input. Include unresolved work when material. queries is empty unless you need to search for more evidence. Avoid duplicate sections. Keep distinct tasks distinct and do not invent causal connections.";

export function pack<T>(items: T[], limit: number): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  for (const item of items) {
    if (group.length && JSON.stringify([...group, item]).length > limit) {
      groups.push(group);
      group = [];
    }
    group.push(item);
  }
  if (group.length) groups.push(group);
  return groups;
}

export async function summarizeBlocks(
  ctx: Context,
  evidence: Evidence[],
  prefix: string,
): Promise<Material[]> {
  const materials: Material[] = [];
  for (const [index, block] of blocks(
    evidence,
    ctx.options.block_chars,
  ).entries()) {
    const summary = await ctx.ask(
      "summarize",
      `${prefix}/block-${index + 1}`,
      SummarySchema,
      { evidence: project(block) },
      SUMMARY_INSTRUCTION,
    );
    materials.push({
      id: `${prefix}-${index + 1}`,
      ...summary,
      refs: block.map((item) => item.id),
    });
  }
  return materials;
}

export async function reduceMaterials(
  ctx: Context,
  initial: Material[],
  prefix: string,
): Promise<Material[]> {
  let materials = initial;
  const limit = Math.floor(ctx.options.context_chars * 0.45);
  for (let level = 1; JSON.stringify(materials).length > limit; level++) {
    if (level > 12)
      throw new PipelineLimit(
        "Summary reduction did not converge within 12 levels.",
      );
    const next: Material[] = [];
    // Always combine multiple small records; very large single records can be compressed alone.
    for (const [index, group] of pack(materials, limit).entries()) {
      const summary = await ctx.ask(
        "summarize",
        `${prefix}/reduce-${level}-${index + 1}`,
        SummarySchema,
        { materials: group },
        SUMMARY_INSTRUCTION,
      );
      next.push({
        id: `${prefix}-level-${level}-${index}`,
        ...summary,
        refs: referencedIds(summary),
        child_ids: group.map((item) => item.id),
      });
    }
    if (JSON.stringify(next).length >= JSON.stringify(materials).length)
      throw new PipelineLimit(
        "Summary reduction did not shrink the representation. Increase --context-chars.",
      );
    await ctx.save(`${prefix}-level-${level}`, next);
    materials = next;
  }
  return materials;
}

export async function prepareMaterials(
  ctx: Context,
  initial: Material[],
  prefix: string,
): Promise<Prepared> {
  if (!initial.length)
    throw new PipelineLimit("No material available for a narrative.");
  const materials = await reduceMaterials(ctx, initial, prefix);
  const outline = await ctx.ask(
    "outline",
    `${prefix}/outline`,
    OutlineSchema,
    { materials },
    OUTLINE_INSTRUCTION,
  );
  await ctx.save("outline", outline);
  return {
    title: outline.title,
    sections: outline.sections.map((plan) => ({
      plan,
      evidence: materials.filter((item) =>
        item.refs.some((ref) => plan.refs.includes(ref)),
      ),
    })),
  };
}

export async function direct(ctx: Context): Promise<Prepared> {
  const evidence = project(ctx.corpus.evidence);
  const outline = await ctx.ask(
    "outline",
    "direct/outline",
    OutlineSchema,
    { evidence },
    `${OUTLINE_INSTRUCTION} This is the complete normalized source set; plan directly from it without an extraction stage.`,
  );
  await ctx.save("outline", outline);
  // Every writer call sees the full input; overflow is explicit, never silently truncated.
  return {
    title: outline.title,
    sections: outline.sections.map((plan) => ({ plan, evidence })),
  };
}

export async function hierarchical(ctx: Context): Promise<Prepared> {
  const summaries = await summarizeBlocks(
    ctx,
    ctx.corpus.evidence,
    "hierarchical",
  );
  await ctx.save("block-summaries", summaries);
  // Always run a combine stage, even when the leaf summaries fit in one prompt.
  const combined: Material[] = [];
  for (const [i, group] of pack(
    summaries,
    Math.floor(ctx.options.context_chars * 0.45),
  ).entries()) {
    const summary = await ctx.ask(
      "summarize",
      `hierarchical/combine-${i + 1}`,
      SummarySchema,
      { materials: group },
      SUMMARY_INSTRUCTION,
    );
    combined.push({
      id: `combined-${i + 1}`,
      ...summary,
      refs: referencedIds(summary),
      child_ids: group.map((item) => item.id),
    });
  }
  await ctx.save("combined-summaries", combined);
  return prepareMaterials(ctx, combined, "hierarchical");
}

export function allRefs(value: unknown): string[] {
  return referencedIds(value);
}
