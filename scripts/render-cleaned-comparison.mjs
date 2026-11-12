import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Script } from "node:vm";
import { LONG_APPROACHES } from "../packages/experiments/dist/long/pipelines.js";
import { writeComparisonHtml } from "../packages/experiments/dist/long/report.js";
import { readJson } from "../packages/experiments/dist/long/runtime.js";

// Local rendering only: never load an API key or send model requests.
const directory = resolve(
  process.argv[2] ?? ".sessionlore/peekatrack-kimi-four-cleaned-v1",
);
const read = (path) => readJson(join(directory, path));
const manifest = await read("manifest.json"),
  preflight = await read("preflight.json"),
  corpus = await read("primary-corpus.json");
if (!manifest || !preflight || !corpus)
  throw new Error("The frozen comparison inputs are missing");
const results = [],
  documents = [];
for (const approach of LONG_APPROACHES) {
  const result = await read(`${approach}/result.json`);
  if (!result) continue;
  results.push(result);
  if (result.status !== "complete") continue;
  const draft = await read(`${approach}/draft.json`),
    verification = await read(`${approach}/verification.json`);
  if (!draft || !verification)
    throw new Error(`Completed output is missing files: ${approach}`);
  documents.push({ result, draft, reviews: verification.reviews });
}
const comparison = {
  ...((await read("comparison.json")) ?? {}),
  model: manifest.model.model,
  preflight,
  results,
  diagnostics: {
    outline: await read("outline-validation-diagnosis.json"),
  },
};
await writeComparisonHtml(directory, comparison, documents, corpus.evidence);
const html = await readFile(join(directory, "comparison.html"), "utf8");
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log(
  JSON.stringify(
    {
      reader: join(directory, "comparison.html"),
      complete: documents.length,
      planned: LONG_APPROACHES.length,
      api_calls: 0,
    },
    null,
    2,
  ),
);
