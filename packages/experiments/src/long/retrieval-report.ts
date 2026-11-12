import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence } from "../evidence.js";
import type { ComparisonRow } from "./retrieval-comparison.js";

type ReportInput = {
  identity: { model: string };
  source_count: number;
  thread_count: number;
  rows: ComparisonRow[];
  retrieval: {
    case_id: string;
    current: { recall: { groups: { found: boolean }[] } };
    revised: {
      recall: { groups: { found: boolean }[] };
      episodes: { missing_spine_ids: string[] }[];
    };
  }[];
};
type Cases = { id: string; question: string; rubric: string[] }[];
type Assessment = {
  summary?: string;
  case_reviews?: Record<
    string,
    {
      note?: string;
      evaluations?: {
        variant: string;
        note: string;
        criteria?: { criterion: string; status: string; note: string }[];
      }[];
    }
  >;
};
function viewer() {
  const el = (id: string) => document.getElementById(id)!;
  const data = JSON.parse(el("data").textContent!) as {
    result: ReportInput;
    cases: Cases;
    originals: Record<string, Evidence>;
    assessment: Assessment | null;
  };
  const select = el("case") as HTMLSelectElement;
  for (const c of data.cases) {
    const option = document.createElement("option");
    option.value = c.id;
    option.textContent = c.id.replaceAll("_", " ");
    select.append(option);
  }
  const initialCase = location.hash.slice(1);
  if (data.cases.some((c) => c.id === initialCase)) select.value = initialCase;
  el("assessment").textContent =
    data.assessment?.summary ?? "Source-based review has not been added.";
  const titles = {
    current: "Current fragment retrieval",
    "request-result": "Request-to-result retrieval",
    checked: "Request-to-result + detail checks",
  };
  const cite = (id: string) => {
    const button = document.createElement("button");
    button.className = "cite";
    button.textContent = id;
    button.onclick = () => {
      const source = data.originals[id];
      el("source-title").textContent = id;
      el("source-text").textContent = source
        ? JSON.stringify({ ...source, text: undefined }, null, 2) +
          "\n\n" +
          source.text
        : "Source unavailable";
      (el("source") as HTMLDialogElement).showModal();
    };
    return button;
  };
  const render = () => {
    const test = data.cases.find((c) => c.id === select.value)!;
    el("question").textContent = test.question;
    const r = data.result.retrieval.find((r) => r.case_id === test.id)!;
    const recall = (groups: { found: boolean }[]) =>
      groups.filter((g) => g.found).length + "/" + groups.length;
    el("coverage").textContent =
      "Selected evidence groups: current " +
      recall(r.current.recall.groups) +
      "; request-to-result " +
      recall(r.revised.recall.groups) +
      ". This is source recall, not answer accuracy.";
    const review = data.assessment?.case_reviews?.[test.id];
    el("case-note").textContent = review?.note ?? "";
    el("rubric").replaceChildren();
    for (const text of test.rubric) {
      const li = document.createElement("li");
      li.textContent = text;
      el("rubric").append(li);
    }
    el("panels").replaceChildren();
    for (const row of data.result.rows.filter((r) => r.case_id === test.id)) {
      const article = document.createElement("article"),
        title = document.createElement("h2");
      title.textContent = titles[row.variant];
      article.append(title);
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent =
        row.source_ids.length + " source fragments · " + row.status;
      article.append(meta);
      if (row.error && row.answer) {
        const warning = document.createElement("p");
        warning.className = "unknown";
        warning.textContent =
          "Revision saved, but its final audit is incomplete. " + row.error;
        article.append(warning);
      }
      const sources = document.createElement("details"),
        sourceHeading = document.createElement("summary");
      sourceHeading.textContent = "Supplied original records";
      sources.append(sourceHeading);
      row.source_ids.forEach((id) => sources.append(cite(id)));
      article.append(sources);
      const grade = review?.evaluations?.find((e) => e.variant === row.variant);
      if (grade) {
        const p = document.createElement("p");
        p.className = "review";
        p.textContent = grade.note;
        article.append(p);
        if (grade.criteria) {
          const detail = document.createElement("details"),
            heading = document.createElement("summary");
          heading.textContent = "Source-based criterion review";
          detail.append(heading);
          for (const criterion of grade.criteria) {
            const p = document.createElement("p");
            p.textContent =
              criterion.status +
              ": " +
              criterion.criterion +
              " — " +
              criterion.note;
            detail.append(p);
          }
          article.append(detail);
        }
      }
      if (row.answer) {
        const summary = document.createElement("p");
        summary.textContent = row.answer.summary;
        article.append(summary);
        for (const fact of row.answer.facts) {
          const block = document.createElement("div"),
            p = document.createElement("p");
          p.textContent = fact.kind + ": " + fact.text;
          block.append(p);
          fact.refs.forEach((id) => block.append(cite(id)));
          article.append(block);
        }
        for (const unknown of row.answer.unknowns) {
          const p = document.createElement("p");
          p.className = "unknown";
          p.textContent = "Unknown: " + unknown;
          article.append(p);
        }
      } else {
        const p = document.createElement("p");
        p.textContent = row.error;
        article.append(p);
      }
      if (row.audit) {
        const detail = document.createElement("details"),
          heading = document.createElement("summary");
        heading.textContent =
          "Final model detail check: " +
          (row.model_check_passed ? "clear" : "needs review") +
          " (not ground truth)";
        detail.append(heading);
        for (const c of row.audit.coverage) {
          const p = document.createElement("p");
          p.textContent = c.detail_id + " · " + c.status + ": " + c.explanation;
          detail.append(p);
        }
        for (const issue of row.audit.issues) {
          const p = document.createElement("p");
          p.textContent = issue.text;
          detail.append(p);
          issue.refs.forEach((id) => detail.append(cite(id)));
        }
        article.append(detail);
      }
      el("panels").append(article);
    }
  };
  select.onchange = () => {
    location.hash = select.value;
    render();
  };
  window.onhashchange = () => {
    const id = location.hash.slice(1);
    if (data.cases.some((c) => c.id === id)) {
      select.value = id;
      render();
    }
  };
  el("close").onclick = () => (el("source") as HTMLDialogElement).close();
  render();
}
export async function writeRetrievalComparisonHtml(
  output: string,
  result: ReportInput,
  cases: Cases,
  originals: Evidence[],
) {
  let assessment: Assessment | null = null;
  try {
    assessment = JSON.parse(
      await readFile(join(output, "grades.json"), "utf8"),
    ) as Assessment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = JSON.stringify({
    result,
    cases,
    assessment,
    originals: Object.fromEntries(originals.map((e) => [e.id, e])),
  }).replace(/</g, "\\u003c");
  await writeFile(
    join(output, "comparison.html"),
    [
      "<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>PeekaTrack · Kimi retrieval comparison</title>",
      "<style>body{margin:0;background:#f4f2ee;color:#222820;font:16px/1.6 system-ui,sans-serif}header,main{max-width:1680px;margin:auto;padding:24px}h1{line-height:1.2}a{color:#245c43}select,button{font:inherit;padding:8px;border:1px solid #bbb;border-radius:5px;background:white}#panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{background:white;border:1px solid #d7d7cb;padding:22px;border-radius:10px}h2{font-size:20px}.meta{font-size:14px;color:#53634c}.cite{font-size:12px;padding:2px 6px;margin:2px}.unknown,.review{border-left:3px solid #a67a20;padding-left:12px}dialog{width:85%;max-width:950px;max-height:85vh;overflow:auto;border:1px solid #bbb;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}@media(max-width:1000px){#panels{grid-template-columns:1fr}header,main{padding:16px}}</style>",
      "<header><p class='meta'>SESSIONLORE · FULL PEEKATRACK HISTORY · KIMI ONLY</p><h1>Follow the request through to its result.</h1><p>Same question, model, source budget and initial writer. Compare fragment retrieval, request-to-result retrieval, and a source-derived detail check.</p><p><a href='review.md'>Source-based review</a> · <a href='answers.md'>All saved answers</a> · <a href='comparison.json'>Raw results and usage</a></p>",
      "<label for='case'>Diagnostic case</label> <select id='case'></select><h2 id='question'></h2><p class='meta' id='coverage'></p><details><summary>Evaluation criteria (never sent to Kimi)</summary><ul id='rubric'></ul></details></header>",
      "<main><p id='assessment'></p><p id='case-note'></p><div id='panels'></div></main><dialog id='source'><button id='close'>Close evidence</button><h2 id='source-title'></h2><pre id='source-text'></pre></dialog>",
      "<script type='application/json' id='data'>" +
        data +
        "</script><script>(" +
        viewer.toString() +
        ")();</script></html>",
    ].join("\n"),
    { mode: 0o600 },
  );
}
