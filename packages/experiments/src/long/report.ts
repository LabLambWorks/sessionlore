import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence } from "../evidence.js";
import type { LongResult } from "./index.js";
import { LONG_NAMES, type LongOutline } from "./pipelines.js";
import { readJson } from "./runtime.js";
import type { LongDraft, Review } from "./writing.js";

export async function writeComparisonHtml(
  directory: string,
  comparison: unknown,
  documents: { result: LongResult; draft: LongDraft; reviews: Review[] }[],
  evidence: Evidence[],
) {
  const outlines: Record<string, LongOutline | null> = Object.fromEntries(
    await Promise.all(
      Object.keys(LONG_NAMES).map(async (approach) => [
        approach,
        await readJson<LongOutline>(join(directory, approach, "outline.json")),
      ]),
    ),
  );
  const budget = await readJson(join(directory, "resume-budget.json"));
  for (const [approach, outline] of Object.entries(outlines)) {
    if (!outline) continue;
    const cards = outline.sections.map((section, i) => ({
      order: i + 1,
      ...section,
    }));
    await writeFile(
      join(directory, approach, "outline-cards.json"),
      `${JSON.stringify(
        {
          kind: "ordered-outline-cards",
          approach,
          title: outline.title,
          source_artifact: "outline.json",
          transformation:
            "Display only; saved section order and fields are unchanged. This is not the pivot pipeline's ordered-cards artifact.",
          cards,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, approach, "outline-cards.md"),
      [
        `# ${outline.title}`,
        "",
        "Saved pre-writing order from outline.json. These are planning cards, not final devlog paragraphs or pivot cards.",
        "",
        ...cards.flatMap((card) => [
          `## ${card.order}. ${card.heading}`,
          "",
          card.focus,
          "",
          `Sources: ${card.refs.map((id) => `[${id}](../sources.md#${id})`).join(" ")}`,
          "",
          "Evidence questions:",
          "",
          ...card.queries.map((query) => `- ${query}`),
          "",
        ]),
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  const ids = new Set([
    ...documents.flatMap((doc) => [
      ...doc.draft.sections.flatMap((section) =>
        section.claims.flatMap((claim) => claim.refs),
      ),
      ...doc.reviews.flatMap((review) => review.replacement?.refs ?? []),
    ]),
    ...Object.values(outlines).flatMap(
      (outline) => outline?.sections.flatMap((section) => section.refs) ?? [],
    ),
  ]);
  const data = JSON.stringify({
    comparison,
    documents,
    outlines,
    budget,
    names: LONG_NAMES,
    evidence: Object.fromEntries(
      evidence
        .filter((item) => ids.has(item.id))
        .map((item) => [item.id, item]),
    ),
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeekaTrack · Pipeline outputs</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f2ee;color:#232522;font:16px/1.65 system-ui,sans-serif}header{padding:24px 24px 12px;max-width:1450px}h1{font-size:30px;line-height:1.2;margin:4px 0 10px}h2{font-size:22px;line-height:1.3}h3{font-size:18px;line-height:1.35;margin:24px 0 12px}p{margin:0 0 16px}.note{color:#576159;font-size:14px}button,select{font:inherit;padding:7px 10px;border:1px solid #b6beb5;border-radius:5px;background:#fff;color:#22543c;cursor:pointer}.controls{display:flex;gap:22px;flex-wrap:wrap;align-items:center;margin:18px 0 12px}label{display:flex;gap:8px;align-items:center}main{padding:0 20px 40px;overflow-x:auto}#panels{display:grid;grid-template-columns:repeat(4,minmax(280px,1fr));gap:16px;align-items:start}.panel{background:#fff;border:1px solid #dcded7;border-radius:9px;padding:20px;min-width:0}.method{font-size:13px;font-weight:700;color:#35563c;min-height:44px}.stats{font-size:12px;color:#5a665a;margin:8px 0 18px}.claim{margin:0 0 20px}.claim p{margin:0 0 5px}.cite{font-size:11px;padding:1px 5px;margin:2px 2px 0 0;border-color:#d2ddd1;background:#f6f9f4}.hide-citations .cite{display:none}.verdict{font-size:12px;color:#82592f;background:#fcf5e9;padding:8px;margin-top:8px}.links{font-size:12px;display:flex;gap:12px}.empty{font-style:italic;color:#666}a{color:#22543c}dialog{width:min(950px,90vw);max-height:85vh;overflow:auto;border:1px solid #a8b2a7;border-radius:10px;padding:24px}dialog::backdrop{background:#0007}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}.single #panels{display:block;max-width:850px;margin:auto}.single .panel{display:none}.single .panel.selected{display:block}@media print{header .controls,.cite,.links{display:none}main{overflow:visible}#panels{display:block}.panel{break-before:page;border:0}}
</style>
<header><div class="note">SESSIONLORE · KIMI · FULL CLEANED HISTORY</div><h1>PeekaTrack, in my own words</h1><p id="intro">Four devlogs from the same cleaned conversation, using the same model and first-person writing brief.</p><p class="note" id="scope"></p><p class="note" id="live-status"></p><p class="note" id="outline-note" hidden>These cards show the exact saved pre-writing outline, in its original order. They contain planning text, not final devlog paragraphs. This is not the older pivot pipeline’s ordered-cards artifact.</p><div class="controls"><label>Output <select id="version"><option value="final">Final pipeline output</option><option value="draft">Original draft + review notes</option><option value="outline">Pre-writing order (cards)</option></select></label><label>Layout <select id="layout"><option value="all">All four side by side</option></select></label><label><input id="citations" type="checkbox" checked> Show citations</label></div><p class="note">Scroll sideways on a narrow screen. Citations open the complete original message. The final output includes the source review's corrections; withheld paragraphs remain in the draft. This is one run per approach. The same-model review is not independent proof of accuracy.</p><a href="comparison.md">Run details and measured usage</a> <button id="reload" hidden>Reload results</button></header>
<main><div id="panels"></div><details id="run-status" style="max-width:850px;margin:24px auto"><summary>Completion status for all four approaches</summary><ul id="status-list"></ul></details></main><dialog id="source"><button id="close">Close source</button><h2 id="source-title"></h2><pre id="source-body"></pre></dialog>
<script type="application/json" id="data">${data}</script><script>
const data=JSON.parse(document.getElementById('data').textContent);
const version=document.getElementById('version'),layout=document.getElementById('layout');
const p=data.comparison.preflight;
if(data.documents.length<4){document.getElementById('intro').textContent='Only '+data.documents.length+' of 4 devlogs '+(data.documents.length===1?'is':'are')+' complete. The completed output is shown below. Other approaches retain their saved progress.';document.getElementById('reload').hidden=false;document.getElementById('reload').onclick=()=>location.reload()}
document.getElementById('scope').textContent=data.comparison.model+' · '+p.fragments.toLocaleString()+' retained records · '+p.thread_ids.length+' chats · no time filter or source-text truncation · same frozen corpus';
for(const [approach,name] of Object.entries(data.names)){if(!data.outlines[approach]&&!data.documents.some(doc=>doc.result.approach===approach))continue;const option=document.createElement('option');option.value=approach;option.textContent=name;layout.append(option)}
const requested=location.hash.slice(1),requestedView=new URLSearchParams(location.search).get('view');
if(['final','draft','outline'].includes(requestedView))version.value=requestedView;
if(requested==='all'||data.documents.some(doc=>doc.result.approach===requested)||data.outlines[requested])layout.value=requested;
else if(data.documents.length>0&&data.documents.length<4)layout.value=data.documents[0].result.approach;
function text(tag,value,className){const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e}
function active(approach){const pending=data.budget?.pending;return Boolean(pending&&(pending.approach===approach||pending.stage?.startsWith(approach+'/')))}
function unfinished(approach,result){
 if(active(approach))return 'Running: '+data.budget.pending.stage+'. Current generation-call cap: '+data.budget.limits.calls+'. Completed work is reused.';
 if(approach.startsWith('hierarchy')&&data.comparison.diagnostics?.outline?.recovered_from_cache)return 'The outline and writing material were recovered from cache. Writing and source review still need to finish.';
 if(approach.startsWith('hierarchy')&&data.comparison.diagnostics?.outline?.all_outline_refs_in_cleaned_corpus)return 'Stopped by a citation-validation bug. The outline and summaries are saved; no final devlog was produced.';
 if(data.budget?.blocked&&result?.status!=='complete')return data.budget.blocked+'. Completed work is saved.';
 if(result?.reason?.includes('call')&&result.reason.includes('cap'))return 'The previous run stopped at a call cap. The current cap is '+(data.budget?.limits?.calls??'shown in run details')+'; completed work is saved.';
 return result?.reason?'Stopped before producing a final devlog. Completed work is saved.':'No final devlog has been produced.';
}
function status(){
 const list=document.getElementById('status-list');list.replaceChildren();
 for(const [approach,name] of Object.entries(data.names)){const result=data.comparison.results?.find(r=>r.approach===approach);list.append(text('li',name+': '+(result?.status==='complete'?'Complete.':unfinished(approach,result))))}
 const pending=data.budget?.pending;
 document.getElementById('live-status').textContent=pending?'Generation in progress: '+pending.stage+' · '+data.budget.calls+' calls recorded · cap '+data.budget.limits.calls+'.':data.documents.length===4?'All four final devlogs are complete.':data.budget?.blocked?'Generation paused: '+data.budget.blocked+'.':'Saved results. Status updates here use local files only.';
 for(const panel of document.querySelectorAll('.panel[data-incomplete]')){const approach=panel.dataset.approach;const result=data.comparison.results?.find(r=>r.approach===approach);panel.querySelector('h2').textContent=active(approach)?'Running':result?.reason?'Stopped — no devlog':'No output yet';panel.querySelector('.empty').textContent=unfinished(approach,result)}
}
function citations(block,refs){for(const id of refs){const b=text('button',id,'cite');b.onclick=()=>{const item=data.evidence[id];document.getElementById('source-title').textContent=id;document.getElementById('source-body').textContent=item?JSON.stringify({...item,text:undefined},null,2)+String.fromCharCode(10,10)+item.text:'Source unavailable';document.getElementById('source').showModal()};block.append(b)}}
function link(label,href){const a=text('a',label);a.href=href;return a}
function render(){
 const root=document.getElementById('panels');root.replaceChildren();
 document.getElementById('outline-note').hidden=version.value!=='outline';
 for(const [approach,name] of Object.entries(data.names)){
  const doc=data.documents.find(d=>d.result.approach===approach),outline=data.outlines[approach];
  const panel=document.createElement('article');panel.className='panel'+(layout.value===approach?' selected':'');panel.dataset.approach=approach;panel.append(text('div',name,'method'));
  if(version.value==='outline'&&outline){
   panel.append(text('div',outline.sections.length+' ordered cards · saved before drafting','stats'));
   const links=text('div','','links');links.append(link('Original outline JSON',approach+'/outline.json'),link('Card list',approach+'/outline-cards.md'));panel.append(links,text('h2',outline.title));
   outline.sections.forEach((section,i)=>{const card=text('section','','claim');card.append(text('h3',(i+1)+'. '+section.heading),text('p',section.focus));citations(card,section.refs);if(section.queries.length){const details=document.createElement('details');details.append(text('summary','Evidence questions'));const list=document.createElement('ul');for(const query of section.queries)list.append(text('li',query));details.append(list);card.append(details)}panel.append(card)});
   root.append(panel);continue;
  }
  if(!doc){panel.dataset.incomplete='true';const result=data.comparison.results?.find(r=>r.approach===approach);panel.append(text('h2',active(approach)?'Running':result?.reason?'Stopped — no devlog':'No output yet'),text('p',unfinished(approach,result),'empty'));if(result?.reason){const details=document.createElement('details');details.append(text('summary','Previous error details'),text('pre',result.reason));panel.append(details)}root.append(panel);continue}
  const final=version.value!=='draft',m=doc.result.metrics;
  panel.append(text('div',(final?m.reviewed_words:m.draft_words)+' words · '+doc.result.calls+' stage calls ('+doc.result.cached_calls+' reused)','stats'));
  const links=text('div','','links');for(const [label,file] of [['Final markdown','narrative.md'],['Original draft','draft.md'],['Source review','verification.json']])links.append(link(label,approach+'/'+file));panel.append(links,text('h2',doc.draft.title));
  for(const section of doc.draft.sections){panel.append(text('h3',section.heading));let visible=0;for(const original of section.claims){const review=doc.reviews.find(r=>r.claim_id===original.id),claim=final?(review?.replacement||(review?.verdict==='supported'?original:null)):original;if(!claim)continue;visible++;const block=text('div','','claim');block.dataset.claimId=original.id;block.append(text('p',claim.text));if(claim.status==='inferred')block.append(text('span','Interpretation · ','note'));citations(block,claim.refs);if(!final&&review?.verdict!=='supported')block.append(text('div',review?.verdict+': '+review?.reason+(review?.replacement?' — corrected in final output.':' — withheld from final output.'),'verdict'));panel.append(block)}if(!visible)panel.append(text('p','This section has no retained paragraphs after the source check.','empty'))}
  root.append(panel);
 }
 document.body.classList.toggle('single',layout.value!=='all');status();
}
function changeView(){const url=new URL(location.href);url.searchParams.set('view',version.value);url.hash=layout.value;history.replaceState(null,'',url);render()}
version.onchange=changeView;layout.onchange=changeView;document.getElementById('citations').onchange=e=>document.body.classList.toggle('hide-citations',!e.target.checked);document.getElementById('close').onclick=()=>document.getElementById('source').close();render();
if(data.documents.length<4&&location.protocol.startsWith('http'))setInterval(async()=>{try{const response=await fetch('resume-budget.json',{cache:'no-store'});if(response.ok){data.budget=await response.json();status()}}catch{}},5000);
</script></html>`;
  await writeFile(join(directory, "comparison.html"), html, { mode: 0o600 });
}
