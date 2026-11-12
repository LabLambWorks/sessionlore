// Local artifact rendering only; no provider calls or prose rewriting.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import {
  assembleInventory,
  inventoryRequest,
} from "../packages/experiments/dist/request-inventory.js";

const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: ".sessionlore/peekawild-request-inventory-v1",
    },
  },
});
const out = resolve(values.out);
const records = await readJson(join(out, "records.json"));
const batches = await readJson(join(out, "batches.json"));
const results = [];
for (const batch of batches) {
  const saved = await readJson(join(out, "results", `${batch.id}.json`));
  if (!saved) continue;
  assert.equal(saved.request_hash, hash(inventoryRequest(batch)));
  results.push({ batch, value: saved.response });
}
const inventory = assembleInventory(records, results);
const savedInventory = await readJson(join(out, "inventory.json"));
if (savedInventory) assert.deepEqual(inventory, savedInventory);
const budget = await readJson(join(out, "resume-budget.json"));
const capture = await readJson(join(out, "capture.json"));
const qualityReview = await readJson(join(out, "quality-review.json"));
const counts = (field) =>
  Object.fromEntries(
    [...new Set(inventory.items.map((i) => i[field]))]
      .sort()
      .map((key) => [
        key,
        inventory.items.filter((i) => i[field] === key).length,
      ]),
  );
const summary = {
  status: inventory.status,
  rendered_at: new Date().toISOString(),
  project: capture.project,
  project_chats: capture.chat_ids,
  target_records: inventory.coverage.target_records,
  processed_records: inventory.coverage.processed_records,
  pending_records: inventory.coverage.pending_ids.length,
  items: inventory.items.length,
  by_kind: counts("kind"),
  by_scope: counts("scope"),
  by_area: counts("area"),
  with_stated_reason: inventory.items.filter((i) => i.reason).length,
  uncertain_items: inventory.items.filter((i) => i.uncertainty).length,
  quotation_issues: inventory.items.filter((i) => i.quotation_issues.length)
    .length,
  non_request_records: inventory.coverage.ledger.filter(
    (r) => !r.item_ids.length,
  ).length,
  usage: budget
    ? {
        calls: budget.calls,
        input_tokens: budget.entries.reduce(
          (n, e) => n + (e.input_tokens ?? 0),
          0,
        ),
        output_tokens: budget.entries.reduce(
          (n, e) => n + (e.output_tokens ?? 0),
          0,
        ),
        total_tokens: budget.used_tokens,
        pending: budget.pending,
        blocked: budget.blocked,
        limits: budget.limits,
      }
    : null,
  limitations: [
    "Each processed request/answer record has an extraction result or exclusion reason. Pending records are listed separately. This does not prove every requested detail was extracted.",
    "Focused is a scope label, not an estimate of effort.",
    "Image-only details were not interpreted.",
    "Implementation status was not checked.",
    "Exclusion labels and missing reasons are model judgments; inspect the original messages when reviewing them.",
  ],
};
await atomicJson(join(out, "summary.json"), summary);
const csv = (value) => {
  const raw = String(value ?? "");
  const safe = /^[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};
const csvRows = [
  [
    "id",
    "date",
    "area",
    "kind",
    "scope",
    "request",
    "stated_reason",
    "reason_actor",
    "source_quote",
    "uncertainty",
    "citation_issue",
    "implementation_status",
    "chat_url",
  ],
];
for (const i of inventory.items)
  csvRows.push([
    i.id,
    i.timestamp,
    i.area,
    i.kind,
    i.scope,
    i.request,
    i.reason?.text,
    i.reason_actor,
    i.quote,
    i.uncertainty,
    i.quotation_issues.join(", "),
    i.implementation_status,
    i.chat_url,
  ]);
await writeFile(
  join(out, "inventory.csv"),
  csvRows.map((row) => row.map(csv).join(",")).join("\r\n"),
  { mode: 0o600 },
);
const lines = [
  "# PeekaWild request inventory",
  "",
  `${summary.status}: ${summary.items} extracted items from ${summary.processed_records}/${summary.target_records} request and answer records.`,
  "",
  "Implementation status is not checked. Focused is a scope label, not an effort estimate. Repeated requests and later refinements remain separate.",
  "",
];
for (const i of inventory.items) {
  lines.push(
    `## ${i.id} · ${i.area} · ${i.kind} · ${i.scope}`,
    "",
    i.request,
    "",
    `Date: ${i.timestamp ?? "unknown"}. [Open source chat](${i.chat_url}). Source record: ${i.record_id}.`,
    "",
    `Reason: ${i.reason ? `${i.reason.text} (${i.reason_actor}, ${i.reason.source_id})` : "No reason extracted. Check the original message for context."}`,
    "",
    `Original wording: ${i.quote}`,
    "",
  );
  if (i.uncertainty) lines.push(`Uncertainty: ${i.uncertainty}`, "");
  if (i.quotation_issues.length)
    lines.push(
      `Quotation needs review: ${i.quotation_issues.join(", ")}. Consult the original message.`,
      "",
    );
}
await writeFile(join(out, "inventory.md"), lines.join("\n"), { mode: 0o600 });
const payload = JSON.stringify({
  summary,
  inventory,
  qualityReview,
  records: Object.fromEntries(records.map((r) => [r.id, r])),
}).replace(/</g, "\\u003c");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeekaWild · Requested changes</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f5f3ee;color:#24332e;font:16px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 24px}h1{font-size:34px;margin:6px 0 12px;line-height:1.2}h2{font-size:20px;margin:0 0 10px}.muted{color:#596861;font-size:14px}.controls{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}label{font-size:14px;display:grid;gap:4px}input,select,button{font:inherit;border:1px solid #b5c3b8;border-radius:6px;padding:8px;background:white;color:#224b39}input{min-width:260px}button,a{cursor:pointer}a{color:#225c40}button:disabled{opacity:.45;cursor:default}.card{padding:22px;background:white;border:1px solid #d8dfd5;border-radius:10px;margin:14px 0}.tags{font-size:12px;display:flex;gap:8px;flex-wrap:wrap;color:#4c6657;margin-bottom:8px}.tag{background:#edf2e8;border-radius:4px;padding:2px 7px}.source{font-size:13px;padding:4px 8px}.links{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}.reason{border-left:3px solid #a8c9a4;padding-left:12px}.warning{color:#8b4a12;background:#fff5e3;padding:10px;border-radius:5px}.pager{display:flex;gap:16px;align-items:center;justify-content:space-between;margin:22px 0}dialog{width:min(900px,94vw);max-height:85vh;overflow:auto;border:1px solid #b6c4b7;border-radius:10px;padding:24px}dialog::backdrop{background:#17231b88}pre{font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}blockquote{border-left:2px solid #ccd7c7;padding-left:12px;margin-left:0}</style>
<main><div class="muted">SESSIONLORE · REQUEST INVENTORY</div><h1>PeekaWild: requested changes</h1><p id="summary"></p><p id="status" class="warning" hidden></p><p class="muted" id="usage"></p><p class="muted">Small refinements, larger features, fixes and follow-ups are preserved. Implementation status has not been checked. “Focused” describes the scope of a request, not its effort.</p>
<div class="links"><a href="inventory.csv" download>Download CSV</a><a href="inventory.md">Full Markdown</a><a href="inventory.json">Full JSON and coverage</a><a href="summary.json">Usage and counts</a></div><details id="quality" hidden><summary>Source review notes</summary><div id="quality-findings"></div></details>
<div class="controls"><label>Search<input id="search" type="search" placeholder="Request, reason or original wording"></label><label>Scope<select id="scope"><option value="">All scopes</option><option>focused</option><option>broad</option><option>unclear</option></select></label><label>Area<select id="area"><option value="">All areas</option></select></label><label>Kind<select id="kind"><option value="">All kinds</option></select></label><label>Review<select id="review"><option value="">All items</option><option value="uncertain">Needs context</option><option value="quote">Quotation check</option><option value="reason">Has a stated reason</option></select></label></div>
<div class="pager"><span id="count"></span><span><button id="prev">Previous</button> <button id="next">Next</button></span></div><div id="items"></div><p class="muted">Each processed request and answer has an extraction result or an explicit exclusion reason. Pending records are listed in the coverage JSON. This is a coverage check, not a guarantee that every detail was captured.</p><details><summary id="exclusion-count">Non-request records</summary><div id="exclusions"></div></details></main>
<dialog id="source"><button id="close">Close source</button><h2 id="source-title"></h2><p id="source-meta"></p><pre id="source-text"></pre></dialog>
<script id="data" type="application/json">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent), controls=['search','scope','area','kind','review'].map(id=>document.getElementById(id));let page=0;const size=40;
const el=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n};
document.getElementById('summary').textContent=data.summary.items+' extracted items · '+data.summary.processed_records+'/'+data.summary.target_records+' request and answer records processed · '+data.summary.project_chats+' recorded chats · '+data.summary.status;
if(data.summary.pending_records){const status=document.getElementById('status');status.hidden=false;status.textContent='Incomplete: '+data.summary.pending_records+' records remain. '+(data.summary.usage?.blocked||'Extraction has not finished.')+'. Saved results are shown below.';}
document.getElementById('usage').textContent=data.summary.usage?data.summary.usage.calls+' Kimi calls · '+data.summary.usage.total_tokens.toLocaleString()+' measured tokens · '+data.summary.with_stated_reason+' items with a stated reason · '+data.summary.uncertain_items+' items needing context':'';
for(const field of ['area','kind'])for(const key of Object.keys(data.summary['by_'+field])){const option=el('option',key+' ('+data.summary['by_'+field][key]+')');option.value=key;document.getElementById(field).append(option)}
const query=new URLSearchParams(location.search);for(const control of controls)if(query.has(control.id))control.value=query.get(control.id);
function source(id){const r=data.records[id];document.getElementById('source-title').textContent=id+' · '+r.role;document.getElementById('source-meta').textContent=(r.timestamp||'Unknown date')+' · '+r.thread_id+' · source refs '+r.source_refs.join(', ');document.getElementById('source-text').textContent=r.text;document.getElementById('source').showModal()}
function sourceButton(id,label){const button=el('button',label||id,'source');button.onclick=()=>source(id);return button}
if(data.qualityReview?.findings?.length){document.getElementById('quality').hidden=false;const root=document.getElementById('quality-findings');root.append(el('p','These review notes identify limits in the saved Kimi output. They do not change its wording.','muted'));for(const finding of data.qualityReview.findings){const p=el('p',finding.finding+' ');p.append(sourceButton(finding.source_id,'Original '+finding.source_id));root.append(p)}}
function render(){const [search,scope,area,kind,review]=controls.map(c=>c.value);const text=search.toLowerCase();const all=data.inventory.items.filter(i=>(!scope||i.scope===scope)&&(!area||i.area===area)&&(!kind||i.kind===kind)&&(!text||[i.request,i.quote,i.reason?.text,i.uncertainty].join(' ').toLowerCase().includes(text))&&(!review||(review==='uncertain'&&i.uncertainty)||(review==='quote'&&i.quotation_issues.length)||(review==='reason'&&i.reason)));page=Math.min(page,Math.max(0,Math.ceil(all.length/size)-1));document.getElementById('count').textContent=all.length+' matching items · page '+(page+1)+' of '+Math.max(1,Math.ceil(all.length/size));document.getElementById('prev').disabled=page===0;document.getElementById('next').disabled=(page+1)*size>=all.length;const root=document.getElementById('items');root.replaceChildren();
for(const i of all.slice(page*size,(page+1)*size)){const card=el('article','','card'),tags=el('div','','tags');for(const tag of [i.id,i.area,i.kind,i.scope])tags.append(el('span',tag,'tag'));card.append(tags,el('h2',i.request));if(i.reason)card.append(el('p','Reason: '+i.reason.text+' — '+(['assistant_report','question'].includes(i.reason_actor)?'Codex explanation or proposal':'Recorded human request or answer'),'reason'));else card.append(el('p','No reason extracted. Check the original message for context.','muted'));if(i.uncertainty)card.append(el('p',i.uncertainty,'warning'));if(i.quotation_issues.length)card.append(el('p','Quotation needs review; inspect the original message.','warning'));const details=document.createElement('details');details.append(el('summary','Original wording and context'),el('blockquote',i.quote));const links=el('div','','links');links.append(sourceButton(i.record_id,'Original request'));for(const id of i.context_ids)if(id!==i.record_id)links.append(sourceButton(id,'Context '+id));if(i.reason)links.append(sourceButton(i.reason.source_id,'Reason source'));details.append(links);card.append(details);const meta=el('p',(i.timestamp||'Unknown date')+' · ','muted'),a=el('a','Open Codex chat');a.href=i.chat_url;meta.append(a);card.append(meta);root.append(card)}if(!all.length)root.append(el('p','No matching items.'))}
for(const c of controls)c.oninput=()=>{page=0;const u=new URL(location.href);for(const c of controls)c.value?u.searchParams.set(c.id,c.value):u.searchParams.delete(c.id);history.replaceState(null,'',u);render()};document.getElementById('prev').onclick=()=>{page--;render()};document.getElementById('next').onclick=()=>{page++;render()};document.getElementById('close').onclick=()=>document.getElementById('source').close();
const exclusions=data.inventory.coverage.ledger.filter(r=>!r.item_ids.length);document.getElementById('exclusion-count').textContent=exclusions.length+' records excluded by Kimi — review the originals';for(const r of exclusions){const p=el('p',r.no_request_reason+' ');p.append(sourceButton(r.id));document.getElementById('exclusions').append(p)}render();
</script></html>`;
await writeFile(join(out, "inventory.html"), html, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
