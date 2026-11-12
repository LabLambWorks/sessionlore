import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence } from "../evidence.js";
import type { runEvidenceDiagnostic } from "./diagnostic.js";

export async function writeDiagnosticHtml(
  output: string,
  result: Awaited<ReturnType<typeof runEvidenceDiagnostic>>,
  cases: { id: string; question: string; rubric: string[] }[],
  originals: Evidence[],
) {
  let assessment: unknown = null;
  try {
    assessment = JSON.parse(
      await readFile(join(output, "grades.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = JSON.stringify({
    result,
    cases,
    assessment,
    originals: Object.fromEntries(originals.map((item) => [item.id, item])),
  }).replace(/</g, "\\u003c");
  await writeFile(
    join(output, "comparison.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeekaTrack · Evidence diagnostic</title><style>
body{margin:0;background:#f4f2ee;color:#222820;font:16px/1.6 system-ui,sans-serif}header,main{max-width:1500px;margin:auto;padding:24px}h1{line-height:1.2}a{color:#245c43}select,button{font:inherit;padding:8px;border:1px solid #bbb;border-radius:5px;background:white}#panels{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{background:white;border:1px solid #d7d7cb;padding:22px;border-radius:10px;min-width:0}h2{font-size:20px}.meta{font-size:14px;color:#53634c}.cite{font-size:12px;padding:2px 6px;margin:2px}.fact{margin:16px 0}.unknown{border-left:3px solid #a67a20;padding-left:12px}dialog{width:85%;max-width:950px;max-height:85vh;overflow:auto;border:1px solid #bbb;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}@media(max-width:800px){#panels{grid-template-columns:1fr}header,main{padding:16px}}</style>
<header><p class="meta">SESSIONLORE · FULL PEEKATRACK HISTORY · TWO MODELS</p><h1>Correct evidence first. Full-history retrieval second.</h1><p>Compare the same question and evidence across DeepSeek Flash and Kimi Code. Selected-source inputs isolate extraction; retrieved inputs test evidence selection from every chat.</p><p><a href="review.md">Source-based results and verdict</a> · <a href="answers.md">All answers and evaluation criteria</a></p><label for="case">Diagnostic case</label> <select id="case"></select><h2 id="question"></h2><p class="meta" id="coverage"></p><details><summary>Evaluation criteria (not sent to either model)</summary><ul id="rubric"></ul></details></header>
<main><p id="assessment"></p><p id="case-review"></p><div id="panels"></div></main><dialog id="source"><button id="close">Close evidence</button><h2 id="source-title"></h2><pre id="source-text"></pre></dialog>
<script type="application/json" id="data">${data}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),select=document.getElementById('case');for(const c of data.cases){const option=document.createElement('option');option.value=c.id;option.textContent=c.id.replaceAll('_',' ');select.append(option)}
document.getElementById('assessment').textContent=data.assessment?.summary??'Source-based review has not been added.';
function cite(id){const b=document.createElement('button');b.className='cite';b.textContent=id;b.onclick=()=>{const s=data.originals[id];document.getElementById('source-title').textContent=id;document.getElementById('source-text').textContent=s?JSON.stringify({...s,text:undefined},null,2)+'\\n\\n'+s.text:'Source unavailable';document.getElementById('source').showModal()};return b}
function render(){const c=data.cases.find(c=>c.id===select.value);document.getElementById('question').textContent=c.question;const review=data.assessment?.case_reviews?.[c.id];document.getElementById('case-review').textContent=review?.note??'';const r=data.result.retrieval.find(r=>r.case_id===c.id);document.getElementById('coverage').textContent=r.recall.groups.filter(g=>g.found).length+'/'+r.recall.groups.length+' selected evidence groups found in '+r.source_ids.length+' retrieved fragments · '+data.result.source_count+' fragments searched · no time filter. Evidence recall is not answer accuracy.';const rubric=document.getElementById('rubric');rubric.replaceChildren();for(const text of c.rubric){const li=document.createElement('li');li.textContent=text;rubric.append(li)}const panels=document.getElementById('panels');panels.replaceChildren();for(const m of data.result.identity.models)for(const phase of ['oracle','retrieved']){const row=data.result.rows.find(r=>r.model===m.id&&r.phase===phase&&r.case_id===c.id);const a=document.createElement('article'),h=document.createElement('h2');h.textContent=m.model+' · '+(phase==='oracle'?'Selected originals':'Retrieved originals');a.append(h);const meta=document.createElement('p');meta.className='meta';meta.textContent=row.source_ids.length+' supplied fragments · '+row.status;a.append(meta);const grade=review?.evaluations?.find(e=>e.model===m.id&&e.phase===phase);if(grade){const p=document.createElement('p');p.className='unknown';p.textContent='Source-based assessment: '+grade.note;a.append(p)}if(row.answer){const p=document.createElement('p');p.textContent=row.answer.summary;a.append(p);for(const f of row.answer.facts){const block=document.createElement('div');block.className='fact';const p=document.createElement('p');p.textContent=f.kind+': '+f.text;block.append(p);f.refs.forEach(id=>block.append(cite(id)));a.append(block)}for(const text of row.answer.unknowns){const p=document.createElement('p');p.className='unknown';p.textContent='Unknown: '+text;a.append(p)}}else a.append(document.createTextNode(row.error));panels.append(a)}}select.onchange=render;document.getElementById('close').onclick=()=>document.getElementById('source').close();render();</script></html>`,
    { mode: 0o600 },
  );
}
