import { join } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import { type Evidence, project, SearchIndex, unique } from "../evidence.js";
import { atomicJson, hash, readJson, type TokenCounter } from "./runtime.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export interface Embedder {
  identity: string;
  encode(texts: string[]): Promise<number[][]>;
}

export async function localEmbedder(cacheDirectory: string): Promise<Embedder> {
  env.cacheDir = cacheDirectory;
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: "q8",
    revision: EMBEDDING_REVISION,
  });
  return {
    identity: `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8:mean-of-all-240-token-windows:v1`,
    async encode(texts) {
      const owners: number[] = [];
      const weights: number[] = [];
      const windows: string[] = [];
      for (const [i, text] of texts.entries()) {
        const ids = extractor.tokenizer.encode(text || " ", {
          add_special_tokens: false,
        });
        for (let start = 0; start < Math.max(1, ids.length); start += 240) {
          const part = ids.slice(start, start + 240);
          windows.push(
            extractor.tokenizer.decode(part, { skip_special_tokens: true }) ||
              " ",
          );
          owners.push(i);
          weights.push(Math.max(1, part.length));
        }
      }
      const sums: number[][] = texts.map(() => []);
      for (let start = 0; start < windows.length; start += 16) {
        const output = await extractor(windows.slice(start, start + 16), {
          pooling: "mean",
          normalize: true,
        });
        const vectors = output.tolist() as number[][];
        for (const [j, vector] of vectors.entries()) {
          const i = owners[start + j]!;
          if (!sums[i]!.length) sums[i] = vector.map(() => 0);
          vector.forEach((value, k) => {
            sums[i]![k]! += value * weights[start + j]!;
          });
        }
      }
      return sums.map((vector) => {
        const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
        return vector.map((x) => x / norm);
      });
    },
  };
}

export class HybridIndex {
  readonly lexical: SearchIndex<Evidence>;
  readonly byId: Map<string, Evidence>;
  readonly positions: Map<string, number>;
  readonly queryCache = new Map<string, number[]>();
  constructor(
    readonly evidence: Evidence[],
    readonly vectors: number[][],
    readonly embedder: Embedder,
  ) {
    if (vectors.length !== evidence.length)
      throw new Error("Embedding index does not cover the corpus.");
    this.lexical = new SearchIndex(evidence, (item) => item.text);
    this.byId = new Map(evidence.map((item) => [item.id, item]));
    this.positions = new Map(evidence.map((item, i) => [item.id, i]));
  }
  static async build(
    evidence: Evidence[],
    embedder: Embedder,
    cacheDirectory: string,
    progress: (message: string) => void,
  ) {
    const vectors: number[][] = [];
    const pending = new Map<string, number[]>();
    for (let start = 0; start < evidence.length; start += 32) {
      const batch = evidence.slice(start, start + 32);
      const keys = batch.map((item) =>
        hash({ encoder: embedder.identity, text: item.text }),
      );
      const loaded = await Promise.all(
        keys.map((key) =>
          readJson<number[]>(join(cacheDirectory, `${key}.json`)),
        ),
      );
      const missing = unique(
        keys.filter((key, i) => !loaded[i] && !pending.has(key)),
      );
      if (missing.length) {
        const encoded = await embedder.encode(
          missing.map((key) => batch[keys.indexOf(key)]!.text),
        );
        for (const [i, key] of missing.entries()) {
          const vector = encoded[i]!;
          if (!vector?.length || !vector.every(Number.isFinite))
            throw new Error("Invalid local embedding");
          pending.set(key, vector);
          await atomicJson(join(cacheDirectory, `${key}.json`), vector);
        }
      }
      vectors.push(...keys.map((key, i) => loaded[i] ?? pending.get(key)!));
      if (start % 320 === 0 || start + 32 >= evidence.length)
        progress(
          `Local hybrid index: ${Math.min(start + 32, evidence.length)}/${evidence.length} sources`,
        );
    }
    return new HybridIndex(evidence, vectors, embedder);
  }
  async search(query: string, limit = 12) {
    let vector = this.queryCache.get(query);
    if (!vector) {
      vector = (await this.embedder.encode([query]))[0]!;
      this.queryCache.set(query, vector);
    }
    const dense = this.vectors
      .map((v, i) => ({
        id: this.evidence[i]!.id,
        score: v.reduce((sum, x, k) => sum + x * (vector![k] ?? 0), 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 80);
    const lexical = this.lexical
      .search(query, 80)
      .map((hit) => ({ id: hit.item.id, score: hit.score }));
    const scores = new Map<string, number>();
    for (const ranking of [dense, lexical])
      ranking.forEach((hit, rank) =>
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (60 + rank + 1)),
      );
    return [...scores]
      .sort(
        (a, b) =>
          b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }),
      )
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }));
  }
  async select(
    queries: string[],
    seeds: string[],
    tokenizer: TokenCounter,
    budget: number,
  ) {
    const rankings = await Promise.all(
      queries.map((query) => this.search(query, 12)),
    );
    const score = new Map<string, number>();
    rankings.forEach((hits) =>
      hits.forEach((hit, rank) =>
        score.set(hit.id, (score.get(hit.id) ?? 0) + 1 / (rank + 1)),
      ),
    );
    const ranked = [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const primary = unique([
      ...seeds.filter((id) => this.byId.has(id)),
      ...ranked,
    ]);
    const ordered = unique(
      primary.flatMap((id) => {
        const index = this.positions.get(id)!;
        const item = this.evidence[index]!;
        return [
          id,
          ...[index - 1, index + 1].flatMap((i) => {
            const neighbor = this.evidence[i];
            return neighbor && neighbor.thread_id === item.thread_id
              ? [neighbor.id]
              : [];
          }),
        ];
      }),
    );
    let size = 2;
    const selected: Evidence[] = [];
    for (const id of ordered) {
      const item = this.byId.get(id)!;
      const cost = tokenizer.count(JSON.stringify(project([item])[0])) + 2;
      if (size + cost > budget) continue;
      selected.push(item);
      size += cost;
    }
    return {
      evidence: selected,
      rankings: queries.map((query, i) => ({ query, hits: rankings[i] })),
      omitted_candidate_ids: ordered.filter(
        (id) => !selected.some((item) => item.id === id),
      ),
    };
  }
  catalogue() {
    const threads = unique(this.evidence.map((item) => item.thread_id));
    return threads.map((thread) => {
      const sources = this.evidence.filter((item) => item.thread_id === thread);
      const terms = new Map<string, number>();
      for (const source of sources) {
        const doc = this.lexical.documents[this.positions.get(source.id)!]!;
        for (const [term, tf] of doc.terms) {
          if (
            term.length < 3 ||
            term.length > 45 ||
            /^[\dabcdef-]{12,}$/i.test(term)
          )
            continue;
          const df = this.lexical.frequencies.get(term) ?? 1;
          terms.set(
            term,
            (terms.get(term) ?? 0) +
              Math.log1p(tf) * Math.log(1 + this.evidence.length / df),
          );
        }
      }
      return {
        thread_id: thread,
        source_count: sources.length,
        first: sources[0]?.timestamp,
        last: sources.at(-1)?.timestamp,
        terms: [...terms]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 24)
          .map(([term]) => term),
        human_requests: project(
          sources.filter((source) => source.is_human_turn),
        ),
      };
    });
  }
}
