import { join, resolve } from "node:path";
import { conversationView } from "../conversation.js";
import type { Corpus } from "../evidence.js";
import {
  atomicJson,
  hash,
  loadTokenizer,
  readJson,
  type TokenCounter,
} from "./runtime.js";

/** Local-only preparation from an intact full-project capture. */
export async function prepareConversationCapture(options: {
  sourceDirectory: string;
  output: string;
  tokenizer?: TokenCounter;
}) {
  const source = resolve(options.sourceDirectory),
    output = resolve(options.output);
  if (source === output)
    throw new Error("Use a separate directory for the conversation view.");
  const manifest = await readJson<{
    corpus_sha256: string;
    time_filter: unknown;
  }>(join(source, "manifest.json"));
  const raw = await readJson<Corpus>(join(source, "corpus.json"));
  if (
    !manifest ||
    !raw ||
    manifest.time_filter !== null ||
    hash(raw) !== manifest.corpus_sha256
  )
    throw new Error(
      "An intact full-history capture without a time filter is required.",
    );
  const tokenizer =
    options.tokenizer ??
    (await loadTokenizer(resolve(".sessionlore/models/deepseek-v4-tokenizer")));
  const view = conversationView(raw);
  const summary = {
    ...view.stats,
    source_directory: source,
    corpus_sha256: manifest.corpus_sha256,
    tokenizer: tokenizer.name,
    token_estimate_note:
      "Local tokenizer proxy, not an exact Kimi token count.",
    text_tokens: tokenizer.count(
      view.corpus.evidence.map((e) => e.text).join("\n"),
    ),
    compact_prompt_tokens: tokenizer.count(JSON.stringify(view.compact)),
    compact_prompt_utf8_bytes: Buffer.byteLength(JSON.stringify(view.compact)),
    api_calls: 0,
    time_filter: null,
  };
  await atomicJson(join(output, "conversation.json"), view.compact);
  await atomicJson(join(output, "primary-corpus.json"), view.corpus);
  await atomicJson(join(output, "preflight.json"), summary);
  return { directory: output, ...summary };
}
