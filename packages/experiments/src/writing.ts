import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "./context.js";
import { SearchIndex, unique } from "./evidence.js";
import {
  type Statement,
  type Verdict,
  VerifySchema,
  WritingSchema,
} from "./schema.js";
import type { Prepared } from "./shared.js";

export type Narrative = {
  title: string;
  sections: { heading: string; claims: (Statement & { id: string })[] }[];
};
export function plain(value: string): string {
  return value
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~]/g, "\\$&");
}
function render(
  narrative: Narrative,
  verdicts: Verdict[],
  demo: boolean,
  filtered: boolean,
): string {
  const byId = new Map(verdicts.map((verdict) => [verdict.claim_id, verdict]));
  const lines = [
    `# ${plain(narrative.title)}`,
    "",
    demo
      ? "**OFFLINE DEMONSTRATION — deterministic excerpts, not a model quality result.**"
      : "Private experimental draft. Automated source checks do not establish factual correctness.",
    "",
  ];
  let omitted = 0;
  for (const section of narrative.sections) {
    const claims = section.claims.filter((claim) => {
      if (filtered && !demo && byId.get(claim.id)?.verdict !== "supported") {
        omitted++;
        return false;
      }
      return true;
    });
    if (!claims.length) continue;
    lines.push(`## ${plain(section.heading)}`, "");
    for (const claim of claims) {
      const verdict = byId.get(claim.id);
      const label = claim.status === "inferred" ? "**Inference:** " : "";
      const warning =
        !filtered && verdict && verdict.verdict !== "supported"
          ? ` _[${verdict.verdict}]_`
          : "";
      lines.push(
        `${label}${plain(claim.text)} ${claim.refs.map((id) => `[${id}](../sources.md#${id})`).join(" ")}${warning}`,
        "",
      );
    }
  }
  if (omitted)
    lines.push(
      `${omitted} claims were withheld after automated review. See draft.md and verification.json for the complete draft and reasons.`,
      "",
    );
  return `${lines.join("\n")}\n`;
}

export async function writeAndVerify(ctx: Context, prepared: Prepared) {
  const narrative: Narrative = { title: prepared.title, sections: [] };
  let claimNumber = 0;
  const budget = Math.max(
    1,
    Math.floor(ctx.options.target_words / prepared.sections.length),
  );
  for (const [i, section] of prepared.sections.entries()) {
    const written = await ctx.ask(
      "write",
      `write/section-${i + 1}`,
      WritingSchema,
      {
        heading: section.plan.heading,
        focus: section.plan.focus,
        word_budget: budget,
        evidence: section.evidence,
      },
      "Write connected, plain prose for this devlog section within the word budget. Return a sequence of short atomic claims, each with exact supporting source refs. Each claim is one or two sentences. Include engineering reasons and uncertainty when supported. All supplied interpretations are revisable. Avoid repeated claims, invented causal transitions, and unsupported conclusions. Distinguish reported outcomes from demonstrated outcomes. Do not add markdown or links inside text.",
    );
    narrative.sections.push({
      heading: section.plan.heading,
      claims: written.claims.map((claim) => ({
        ...claim,
        id: `claim-${++claimNumber}`,
      })),
    });
  }
  await ctx.save("draft", narrative);
  // Save before verification so a later model error never loses completed writing.
  await writeFile(
    join(ctx.directory, "draft.md"),
    render(narrative, [], ctx.model.demo, false),
    { flag: "wx", mode: 0o600 },
  );
  const search = new SearchIndex(ctx.corpus.evidence, (item) => item.text);
  const verdicts: Verdict[] = [];
  for (const claim of narrative.sections.flatMap((section) => section.claims)) {
    const cited = ctx.sources(claim.refs);
    // Include likely contradictions and the final source in each cited thread.
    const tails = unique(
      cited.flatMap((item) => (item.thread_id ? [item.thread_id] : [])),
    ).flatMap((thread) =>
      ctx.corpus.evidence.filter((item) => item.thread_id === thread).slice(-1),
    );
    const counterevidence = search.search(claim.text, 3).map((hit) => hit.item);
    const checkedRefs = unique([
      ...claim.refs,
      ...tails.map((item) => item.id),
      ...counterevidence.map((item) => item.id),
    ]);
    const result = await ctx.ask(
      "verify",
      `verify/${claim.id}`,
      VerifySchema,
      {
        claim,
        cited_evidence: ctx.projection(claim.refs),
        context_evidence: ctx.projection(
          checkedRefs.filter((id) => !claim.refs.includes(id)),
        ),
      },
      "Check this atomic claim against the ORIGINAL cited sources, with context for contradiction. supported requires exact scope, actor, time, outcome, and causal strength. An inference must be labelled and justified. A valid source ID is not proof of support. Context may disprove a claim but cannot repair a citation that does not support it. Return unsupported for contradiction or invented details; uncertain for insufficient evidence. Do not trust earlier model summaries.",
    );
    verdicts.push({ claim_id: claim.id, ...result, checked_refs: checkedRefs });
  }
  await ctx.save("verification", {
    method: ctx.model.demo
      ? "demo-no-semantic-check"
      : "same-model-atomic-claim-review-with-original-sources",
    human_review_required: true,
    verdicts,
  });
  await writeFile(
    join(ctx.directory, "narrative.md"),
    render(narrative, verdicts, ctx.model.demo, true),
    { flag: "wx", mode: 0o600 },
  );
  const claims = narrative.sections.flatMap((section) => section.claims);
  return {
    draft_claims: claims.length,
    supported_claims: ctx.model.demo
      ? null
      : verdicts.filter((verdict) => verdict.verdict === "supported").length,
    unsupported_claims: ctx.model.demo
      ? null
      : verdicts.filter((verdict) => verdict.verdict === "unsupported").length,
    uncertain_claims: ctx.model.demo
      ? null
      : verdicts.filter((verdict) => verdict.verdict === "uncertain").length,
    draft_words: claims.reduce(
      (sum, claim) => sum + claim.text.split(/\s+/).filter(Boolean).length,
      0,
    ),
    cited_sources: unique(claims.flatMap((claim) => claim.refs)).length,
  };
}
