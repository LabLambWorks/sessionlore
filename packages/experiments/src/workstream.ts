import type { Context } from "./context.js";
import { blocks, project, SearchIndex, unique } from "./evidence.js";
import {
  type Attempt,
  AttemptsSchema,
  type Material,
  MembershipSchema,
  SummarySchema,
  type Workstream,
} from "./schema.js";
import { type Prepared, prepareMaterials } from "./shared.js";

export async function workstream(ctx: Context): Promise<Prepared> {
  const attempts: Attempt[] = [];
  // Split by thread before extraction; no parent inference is needed for membership.
  for (const thread of unique(
    ctx.corpus.evidence.map(
      (item) => item.thread_id ?? `artifact:${item.artifact_id}`,
    ),
  )) {
    const evidence = ctx.corpus.evidence.filter(
      (item) => (item.thread_id ?? `artifact:${item.artifact_id}`) === thread,
    );
    for (const block of blocks(evidence, ctx.options.block_chars)) {
      const result = await ctx.ask(
        "attempts",
        `workstream/attempts-${attempts.length + 1}`,
        AttemptsSchema,
        { evidence: project(block) },
        "Extract task attempts and their goals. One block may contain multiple interleaved tasks. Include abandoned investigations and unfinished work. Do not select pivots yet. Every input source must belong to at least one attempt; use an explicitly unresolved-context attempt when its purpose is unclear.",
        (result) => {
          const included = new Set(
            result.attempts.flatMap((attempt) => attempt.refs),
          );
          if (block.some((item) => !included.has(item.id)))
            throw new Error(
              "Task attempts must account for every input source ID.",
            );
        },
      );
      attempts.push(
        ...result.attempts.map((attempt, i) => ({
          ...attempt,
          id: `attempt-${attempts.length + i + 1}`,
          thread_id: thread,
        })),
      );
    }
  }
  await ctx.save("attempts", attempts);
  const groups: Workstream[] = [];
  const memberships: unknown[] = [];
  for (const attempt of attempts) {
    const candidates = new SearchIndex(groups, (group) => group.goal)
      .search(`${attempt.goal} ${attempt.summary}`, 6)
      .map((hit) => ({ id: hit.item.id, goal: hit.item.goal }));
    const result = await ctx.ask(
      "membership",
      `workstream/group-${attempt.id}`,
      MembershipSchema,
      { attempt, candidates },
      "Assign this attempt to all matching work goals in the candidate list. Membership can cross threads and be many-to-many. Similar repository or time is not sufficient. Set create_new=true when it represents a distinct goal, including when candidates are empty. Use no candidate when uncertain; preserve a separate group.",
      (result) => {
        if (
          result.group_ids.some(
            (id) => !candidates.some((candidate) => candidate.id === id),
          )
        )
          throw new Error("Group IDs must be supplied candidates.");
        if (!result.create_new && !result.group_ids.length)
          throw new Error(
            "Preserve the attempt in an existing or a new group.",
          );
      },
    );
    if (result.create_new)
      groups.push({
        id: `workstream-${groups.length + 1}`,
        goal: attempt.goal,
        attempt_ids: [attempt.id],
        refs: [...attempt.refs],
      });
    for (const id of unique(result.group_ids)) {
      const group = groups.find((group) => group.id === id)!;
      group.attempt_ids.push(attempt.id);
      group.refs = unique([...group.refs, ...attempt.refs]);
    }
    memberships.push({ attempt_id: attempt.id, ...result });
  }
  await ctx.save("workstreams", {
    groups,
    memberships,
    candidate_method:
      "BM25 top six existing goals; membership is inferred, not ancestry",
  });
  const materials: Material[] = [];
  for (const group of groups) {
    for (const [i, block] of blocks(
      ctx.sources(group.refs),
      ctx.options.block_chars,
    ).entries()) {
      const result = await ctx.ask(
        "decisions",
        `workstream/${group.id}/decisions-${i + 1}`,
        SummarySchema,
        { goal: group.goal, evidence: project(block) },
        "Within this already established work goal, identify decisions, pivots, their supported reasons, actions, outcomes, reversals, and open questions. Return at most eight atomic facts and a short summary. Do not infer a causal trigger from sequence. These are contributions to a workstream, not a single parent chain.",
      );
      materials.push({
        id: `${group.id}-${i + 1}`,
        ...result,
        refs: block.map((item) => item.id),
      });
    }
  }
  await ctx.save("workstream-decisions", materials);
  return prepareMaterials(ctx, materials, "workstream");
}
