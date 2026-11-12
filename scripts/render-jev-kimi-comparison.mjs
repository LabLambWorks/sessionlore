// Local artifact assembly only. This file has no API client or .env access.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  atomicJson,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  renderNarrative,
  reviewedClaim,
} from "../packages/experiments/dist/long/writing.js";

const base = resolve(".sessionlore/peekatrack-kimi-four-cleaned-v1");
const out = resolve(".sessionlore/peekatrack-jev-kimi-full-v1");
const old = await readJson(join(base, "COMPLETED.json"));
const kimiBudget = await readJson(join(out, "resume-budget.json"));
const jevBudget = await readJson(join(out, "jev-budget.json"));
assert.equal(kimiBudget.pending, null);
assert.equal(jevBudget.pending, null);
assert(
  kimiBudget.blocked === null ||
    (kimiBudget.last_stop?.next_stage?.startsWith("verify/") &&
      kimiBudget.blocked.includes("complete next request exceeds")),
);
assert.equal(jevBudget.blocked, null);
const completion = await readJson(
  join(out, "recursive/guarded-completion.json"),
);
assert.equal(completion.covered_sources, 553);
assert.equal(completion.remaining_sources, 0);
assert.equal(completion.duplicate_reads, 0);
const primaryBytes = await readFile(join(out, "primary-corpus.json"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(digest(primaryBytes), old.inputs.primary_corpus_sha256);
const corpus = JSON.parse(primaryBytes),
  sourceIds = new Set(corpus.evidence.map((e) => e.id));
const documents = [];
for (const [id, directory, label] of [
  ["kimi-only", join(base, "recursive"), "Kimi-only recursive"],
  ["recursive", join(out, "recursive"), "JEV decisions + Kimi writing"],
]) {
  const result = await readJson(join(directory, "result.json"));
  assert.equal(result.status, "complete");
  const draft = await readJson(join(directory, "draft.json")),
    final = await readJson(join(directory, "narrative.json"));
  const verification = await readJson(join(directory, "verification.json")),
    outline = await readJson(join(directory, "outline.json"));
  const claims = draft.sections.flatMap((s) => s.claims);
  assert.deepEqual(
    new Set(verification.reviews.map((r) => r.claim_id)),
    new Set(claims.map((c) => c.id)),
  );
  const expected = {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      claims: section.claims
        .map((claim) => reviewedClaim(claim, verification.reviews))
        .filter(Boolean),
    })),
  };
  assert.deepEqual(final, expected);
  assert.equal(
    await readFile(join(directory, "narrative.md"), "utf8"),
    renderNarrative(draft, verification.reviews, true),
  );
  for (const ref of [
    ...final.sections.flatMap((s) => s.claims.flatMap((c) => c.refs)),
    ...outline.sections.flatMap((s) => s.refs),
  ])
    assert(sourceIds.has(ref));
  if (id === "kimi-only") {
    await mkdir(join(out, id), { recursive: true });
    for (const name of [
      "narrative.md",
      "narrative.json",
      "draft.md",
      "draft.json",
      "verification.json",
      "outline.json",
      "result.json",
      "coverage.json",
    ])
      await copyFile(join(directory, name), join(out, id, name));
    const expectedHash = old.outputs.find(
      (item) => item.approach === "recursive",
    ).article_sha256;
    assert.equal(
      digest(await readFile(join(out, id, "narrative.md"))),
      expectedHash,
    );
  }
  documents.push({
    id,
    label,
    final,
    draft,
    reviews: verification.reviews,
    outline,
    result,
  });
}
const sum = (entries) =>
  entries.reduce(
    (a, e) => ({
      calls: a.calls + 1,
      input_tokens: a.input_tokens + e.input_tokens,
      output_tokens: a.output_tokens + e.output_tokens,
    }),
    { calls: 0, input_tokens: 0, output_tokens: 0 },
  );
const newKimi = sum(kimiBudget.entries),
  newJev = sum(jevBudget.entries);
const calls = (await readFile(join(out, "recursive/calls.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse);
const reused = [
  ...new Map(
    calls
      .filter((call) => call.cache_hit && call.stage.startsWith("tree/leaf-"))
      .map((call) => [call.key, call]),
  ).values(),
];
assert.equal(reused.length, 25);
assert(kimiBudget.used_tokens <= kimiBudget.limits.tokens);
assert(kimiBudget.calls <= kimiBudget.limits.calls);
assert(jevBudget.used_tokens <= jevBudget.limits.tokens);
assert(jevBudget.calls <= jevBudget.limits.calls);
const quota = await readJson(join(out, "quota-after.json"));
const summary = {
  completed_at: new Date().toISOString(),
  status: "complete",
  inputs: old.inputs,
  baseline: {
    approach: "Kimi-only recursive",
    words: documents[0].result.metrics.reviewed_words,
    successful_generations: old.recursive_successful_generations,
    measured_tokens: old.recursive_measured_tokens,
    source_processing_fraction:
      documents[0].result.metrics.source_characters_read_fraction,
  },
  mixed: {
    words: documents[1].result.metrics.reviewed_words,
    new_kimi: newKimi,
    new_jev: newJev,
    jev_reading_decisions: jevBudget.entries.filter((entry) =>
      entry.stage.startsWith("guarded/"),
    ).length,
    jev_source_review_calls: jevBudget.entries.filter((entry) =>
      entry.stage.startsWith("verify/"),
    ).length,
    source_review_model: "jev-1.14.0",
    kimi_cap_stop: kimiBudget.blocked,
    new_total_tokens: kimiBudget.used_tokens + jevBudget.used_tokens,
    reused_source_notes: reused.length,
    reused_source_note_usage: sum(reused),
    source_processing_fraction: 1,
    duplicate_reads: 0,
    early_finish_allowed: false,
    unresolved_items_preserved: completion.unresolved.length,
  },
  limits: { kimi: kimiBudget.limits, jev: jevBudget.limits },
  final_quota: quota,
  validation: {
    exact_frozen_corpus: true,
    unchanged_kimi_only_output: true,
    final_articles_match_saved_draft_and_review: true,
    every_paragraph_reviewed: true,
    every_citation_resolves: true,
    all_original_records_covered_once: true,
  },
  limitations: [
    "JEV chooses reading order; code enforces complete coverage. This is not an isolated model swap.",
    "The mixed run reused 25 previously paid source summaries. Incremental usage must not be compared as cold-start cost.",
    "Source processing coverage does not prove that every important detail reached the final devlog.",
    "The baseline review uses Kimi corrections; the mixed review uses JEV support verdicts and withholds unsupported paragraphs. Neither is independent ground truth, and their verdict rates are not directly comparable.",
    "Kimi required one expensive citation repair. Its source check was blocked by the unchanged token cap. JEV finished the support decisions within its existing allowance; no more Kimi generation was sent.",
    "Unresolved outcomes remain explicitly available to the writer; finishing the history scan does not mean those outcomes were resolved.",
  ],
};
await atomicJson(join(out, "COMPLETED.json"), summary);
const runComparison = await readJson(join(out, "comparison.json"));
await atomicJson(join(out, "comparison.json"), {
  ...runComparison,
  controller_model: "jev-1.14.0",
  writing_model: "k3.1-pro",
  reading_policy:
    "complete original-source coverage with duplicate-read guards",
  incremental_usage: { kimi: newKimi, jev: newJev },
  reused_source_notes: summary.mixed.reused_source_note_usage,
  billing:
    "Kimi Code quota plus TypeSafe usage. Provider budgets distinguish new calls from cached source-note work.",
});
const human = [
  "# PeekaTrack: JEV decisions with Kimi writing",
  "",
  "Both saved pipeline outputs are in [the side-by-side reader](comparison.html). The reader also shows the full drafts and original pre-writing outlines as ordered cards. The mixed review removed seven paragraphs, including the entire closing section; pipeline completion is not a quality pass.",
  "",
  "The source-based [quality comparison](QUALITY.md) finds broader detail in the mixed draft but losses in the final output, including supported material that JEV rejected.",
  "",
  `Both runs use the same frozen 553 cleaned records across 23 chats, the same Kimi k3.1-pro writing settings, and the same first-person brief. No time filter or source-text truncation was used. The source reviewers differ: Kimi for the baseline and JEV for this run.`,
  "",
  "| Result | Kimi-only recursive | JEV decisions + Kimi writing |",
  "| --- | ---: | ---: |",
  `| Final words | ${summary.baseline.words} | ${summary.mixed.words} |`,
  `| Source characters processed before review | ${(summary.baseline.source_processing_fraction * 100).toFixed(1)}% | 100% |`,
  `| Source-review corrections | ${documents[0].result.metrics.corrected} | ${documents[1].result.metrics.corrected} |`,
  `| Withheld paragraphs | ${documents[0].result.metrics.withheld} | ${documents[1].result.metrics.withheld} |`,
  "",
  `This run used ${newKimi.calls} new Kimi calls (${kimiBudget.used_tokens.toLocaleString("en-US")} input-plus-output tokens) and ${newJev.calls} JEV calls (${jevBudget.used_tokens.toLocaleString("en-US")} tokens): six reading decisions and two source-review batches. It reused all 25 original-source summaries. No reading summary was regenerated.`,
  "",
  `The earlier Kimi-only recursive run used ${summary.baseline.successful_generations} successful generations and ${summary.baseline.measured_tokens.toLocaleString("en-US")} tokens. This comparison does not establish cold-start savings: the mixed run reuses previously paid notes.`,
  "",
  "The repeated-search fix replaces open-ended queries with a finite set of disjoint evidence batches. Each batch can be selected once. Code rejects completion while any original record remains unread. JEV cannot choose a finish action or invent a query. The ledger confirms all 553 records were covered once, with zero duplicate reads.",
  "",
  "Kimi wrote the outline and devlog, then repaired invalid source IDs once. That repair left too little allowance for a Kimi review, so the cap blocked it before sending. JEV checked every paragraph against the same complete original citations and retrieved counterevidence. JEV produces support verdicts only: unsupported or uncertain paragraphs are withheld, and the full Kimi draft remains available. No prose was manually polished. These checks do not prove accuracy.",
  "",
  "The new controller, full-coverage policy and cached notes all affect this result. A better or worse article cannot be attributed to JEV alone. See [measured usage and validation](COMPLETED.json) and [the source-reading ledger](recursive/guarded-reading-ledger.json).",
  "",
].join("\n");
await writeFile(join(out, "COMPARISON.md"), human, { mode: 0o600 });
const data = JSON.stringify({
  summary,
  documents,
  evidence: Object.fromEntries(corpus.evidence.map((item) => [item.id, item])),
}).replace(/</g, "\\u003c");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeekaTrack · Kimi versus JEV + Kimi</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f2ee;color:#232522;font:16px/1.65 system-ui,sans-serif}header{padding:24px;max-width:1300px}h1{font-size:29px;line-height:1.25;margin:6px 0 14px}h2{font-size:24px;line-height:1.3}h3{font-size:19px;line-height:1.4;margin:26px 0 12px}.note{font-size:14px;color:#536057}.controls{display:flex;gap:20px;flex-wrap:wrap;margin:18px 0}select,button{font:inherit;background:white;border:1px solid #bbc6bb;padding:6px 10px;border-radius:5px;color:#254e38}main{padding:0 20px 30px;overflow-x:auto}#panels{display:grid;grid-template-columns:repeat(2,minmax(350px,1fr));gap:18px;max-width:1500px}.panel{background:white;border:1px solid #d6ddd2;border-radius:9px;padding:24px;min-width:0}.label{font-size:14px;font-weight:700;color:#355c40}.cite{font-size:11px;padding:1px 5px;margin:2px;background:#f2f7ef}p{margin:0 0 14px}.claim{margin-bottom:22px}.claim p{margin-bottom:4px}.links{display:flex;gap:14px;font-size:13px}a{color:#285b3e}.single #panels{display:block;max-width:850px;margin:auto}.single .panel{display:none}.single .selected{display:block}.hide-citations .cite{display:none}dialog{width:min(950px,92vw);max-height:85vh;overflow:auto;border:1px solid #aab6a6;border-radius:10px;padding:22px}dialog::backdrop{background:#0006}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,monospace}</style>
<header><div class="note">SESSIONLORE · COMPLETED RUN</div><h1>PeekaTrack: Kimi-only versus JEV + Kimi</h1><p>Full saved outputs from the same 553 cleaned records across 23 chats. The mixed final is shorter because its review withheld seven paragraphs.</p><p class="note" id="usage"></p><p class="note">JEV chooses the next unread evidence batch. Code prevents duplicate reads and requires complete coverage. This run reuses source summaries, so it tests the guarded pipeline and cache reuse together with JEV.</p><div class="controls"><label>Output <select id="view"><option value="final">Final devlogs</option><option value="outline">Ordered outlines / cards</option><option value="draft">Drafts and review changes</option></select></label><label>Layout <select id="layout"><option value="all">Both side by side</option><option value="kimi-only">Kimi-only recursive</option><option value="recursive">JEV + Kimi</option></select></label><label><input type="checkbox" id="citations" checked> Show citations</label></div><p class="note" id="view-note"></p><a href="QUALITY.md">Source-based quality comparison</a> · <a href="COMPARISON.md">Usage notes</a> · <a href="../comparison.html?view=final#all">Original four approaches</a><p class="note">Assessment: coverage improved, but final quality did not clearly improve. JEV rejected supported material and removed the closing section. Use “Drafts and review changes” to inspect the complete Kimi prose.</p></header><main><div id="panels"></div></main><dialog id="source"><button id="close">Close source</button><h2 id="source-title"></h2><pre id="source-body"></pre></dialog>
<script type="application/json" id="data">${data}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),view=document.getElementById('view'),layout=document.getElementById('layout');
const q=new URLSearchParams(location.search);if(['final','outline','draft'].includes(q.get('view')))view.value=q.get('view');if(['all','kimi-only','recursive'].includes(location.hash.slice(1)))layout.value=location.hash.slice(1);
document.getElementById('usage').textContent='Complete · '+data.summary.mixed.new_kimi.calls+' new Kimi calls · '+(data.summary.mixed.new_kimi.input_tokens+data.summary.mixed.new_kimi.output_tokens).toLocaleString()+' new Kimi tokens · '+data.summary.mixed.new_jev.calls+' JEV calls (6 reading, 2 review) · '+(data.summary.mixed.new_jev.input_tokens+data.summary.mixed.new_jev.output_tokens).toLocaleString()+' JEV tokens · 25 cached summaries reused.';
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e}
function link(label,url){const a=text('a',label);a.href=url;return a}
function refs(root,ids){for(const id of ids){const b=text('button',id,'cite');b.onclick=()=>{const item=data.evidence[id];document.getElementById('source-title').textContent=id;document.getElementById('source-body').textContent=JSON.stringify({...item,text:undefined},null,2)+String.fromCharCode(10,10)+item.text;document.getElementById('source').showModal()};root.append(b)}}
function render(){const root=document.getElementById('panels');root.replaceChildren();document.getElementById('view-note').textContent=view.value==='outline'?'These are the exact saved planning outlines in their original order. They are not rewritten articles.':'The baseline includes Kimi review corrections. This run uses JEV support verdicts; unsupported paragraphs are withheld and remain in the full draft. Neither review is independent ground truth. Click a citation to inspect the complete original message.';
for(const doc of data.documents){const panel=text('article','','panel'+(layout.value===doc.id?' selected':''));panel.dataset.approach=doc.id;panel.append(text('div',doc.label,'label'),text('p',doc.result.metrics.reviewed_words+' final words / '+doc.result.metrics.draft_words+' draft words · '+doc.result.metrics.withheld+' paragraphs withheld · '+(doc.id==='kimi-only'?'Kimi review':'JEV review'),'note'));const links=text('div','','links');links.append(link('Final markdown',doc.id+'/narrative.md'),link('Full draft',doc.id+'/draft.md'),link('Original outline',doc.id+'/outline.json'),link('Source review',doc.id+'/verification.json'));panel.append(links);
if(view.value==='outline'){panel.append(text('h2',doc.outline.title));doc.outline.sections.forEach((s,i)=>{const card=text('section','','claim');card.append(text('h3',(i+1)+'. '+s.heading),text('p',s.focus));refs(card,s.refs);const details=document.createElement('details');details.append(text('summary','Evidence questions'));const ul=document.createElement('ul');for(const query of s.queries)ul.append(text('li',query));details.append(ul);card.append(details);panel.append(card)})}
else{const article=view.value==='draft'?doc.draft:doc.final;panel.append(text('h2',article.title));for(const section of article.sections){panel.append(text('h3',section.heading));if(!section.claims.length)panel.append(text('p','All paragraphs in this section were withheld by the source review. The full draft is available above.','note'));for(const claim of section.claims){const block=text('div','','claim');block.dataset.claimId=claim.id;block.append(text('p',claim.text));if(claim.status==='inferred')block.append(text('p','Interpretation','note'));refs(block,claim.refs);if(view.value==='draft'){const review=doc.reviews.find(r=>r.claim_id===claim.id);if(review?.verdict!=='supported')block.append(text('p',review.verdict+': '+review.reason,'note'))}panel.append(block)}}}root.append(panel)}document.body.classList.toggle('single',layout.value!=='all')}
function change(){const u=new URL(location.href);u.searchParams.set('view',view.value);u.hash=layout.value;history.replaceState(null,'',u);render()}view.onchange=change;layout.onchange=change;document.getElementById('citations').onchange=e=>document.body.classList.toggle('hide-citations',!e.target.checked);document.getElementById('close').onclick=()=>document.getElementById('source').close();render();
</script></html>`;
await writeFile(join(out, "comparison.html"), html, { mode: 0o600 });
console.log(
  JSON.stringify(
    { reader: join(out, "comparison.html"), summary, api_calls: 0 },
    null,
    2,
  ),
);
