import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { z } from "zod";
import { SYSTEM } from "../context.js";
import { referencedIds } from "../evidence.js";
import type { Model, ModelRequest, ModelResponse, Task } from "../model.js";
import {
  ModelBudgetError,
  ModelQuotaError,
  ModelResponseError,
} from "../model.js";

export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
export interface TokenCounter {
  name: string;
  count(text: string): number;
}
export async function loadTokenizer(path: string): Promise<TokenCounter> {
  env.allowRemoteModels = true;
  const tokenizer = await AutoTokenizer.from_pretrained(path, {
    local_files_only: true,
  });
  const digest = createHash("sha256")
    .update(await readFile(join(path, "tokenizer.json")))
    .digest("hex");
  return {
    name: `deepseek-tokenizer:${digest}`,
    count: (text) =>
      tokenizer.encode(text, { add_special_tokens: false }).length,
  };
}

export async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && !failure) {
        const i = cursor++;
        try {
          results[i] = await fn(items[i]!, i);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return results;
}

export type CallRecord = {
  key: string;
  stage: string;
  cache_hit: boolean;
  elapsed_ms: number;
  estimated_input_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number;
  response_model: string | null;
  response_transport?: "json" | "sse";
  provider_rejection?: "quota";
  local_rejection?: "budget";
  ok: boolean;
};
type CachedCall = {
  version: 1;
  key: string;
  created_at: string;
  elapsed_ms: number;
  request: ModelRequest;
  response: ModelResponse;
  estimated_input_tokens: number;
  transport_error?: string;
};

export class RunContext {
  private scheduled = 0;
  readonly calls: CallRecord[] = [];
  readonly readSources = new Set<string>();
  readonly rawReadSources = new Set<string>();
  constructor(
    readonly name: string,
    readonly directory: string,
    readonly cacheDirectory: string,
    readonly model: Model,
    readonly tokenizer: TokenCounter,
    readonly options: {
      inputTokens: number;
      maxCalls: number;
      concurrency: number;
      // Exact requests completed under an earlier transport timeout remain valid.
      cacheTimeouts?: number[];
      // Read-only caches from other runs. Generation settings and input must match.
      cacheDirectories?: string[];
      maxRepairs?: number;
    },
    readonly progress: (message: string) => void,
  ) {}
  async save(name: string, value: unknown) {
    await atomicJson(join(this.directory, `${name}.json`), value);
  }
  async ask<T>(
    task: Task,
    stage: string,
    schema: z.ZodType<T>,
    data: unknown,
    instruction: string,
  ): Promise<T> {
    const allowed = new Set(referencedIds(data));
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(collect);
      const object = value as Record<string, unknown>;
      if (typeof object.id === "string" && /^s\d/.test(object.id))
        allowed.add(object.id);
      // Notes also carry citations in prose, especially unresolved items.
      // Admit only IDs explicitly present in a note supplied to this request
      // AND already processed from original evidence by this run. Do not
      // grant citation access to arbitrary IDs mentioned in raw source text.
      if (
        typeof object.summary === "string" &&
        Array.isArray(object.facts) &&
        Array.isArray(object.unresolved)
      ) {
        for (const text of [object.summary, ...object.unresolved]) {
          if (typeof text !== "string") continue;
          for (const [id] of text.matchAll(/\bs\d+\b/g))
            if (this.readSources.has(id)) allowed.add(id);
        }
      }
      Object.values(object).forEach(collect);
    };
    collect(data);
    let correction = "";
    let repairData: unknown = null;
    const maxRepairs = this.options.maxRepairs ?? 3;
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      if (this.scheduled >= this.options.maxCalls)
        throw new Error(
          `Call budget ${this.options.maxCalls} reached. Completed calls are cached; resume with a larger budget.`,
        );
      this.scheduled++;
      const request: ModelRequest = {
        task,
        stage,
        system: SYSTEM,
        instruction: instruction + correction,
        data: repairData ? { original_input: data, repair: repairData } : data,
        schema: z.toJSONSchema(schema, { target: "draft-7" }),
      };
      const { stage: _stage, ...semantic } = request;
      const identity = {
        version: "long-v1",
        provider: this.model.name,
        model: this.model.model,
        config: this.model.configuration,
      };
      let key = hash({ ...identity, semantic });
      let path = join(this.cacheDirectory, `${key}.json`);
      let cached = await readJson<CachedCall>(path);
      for (const timeout of this.options.cacheTimeouts ?? []) {
        if (cached) break;
        const oldKey = hash({
          ...identity,
          config: { ...identity.config, timeout_ms: timeout },
          semantic,
        });
        const oldPath = join(this.cacheDirectory, `${oldKey}.json`);
        const old = await readJson<CachedCall>(oldPath);
        if (old && !old.transport_error) {
          key = oldKey;
          path = oldPath;
          cached = old;
        }
      }
      for (const directory of this.options.cacheDirectories ?? []) {
        if (cached) break;
        for (const timeout of [
          undefined,
          ...(this.options.cacheTimeouts ?? []),
        ]) {
          const candidateKey = hash({
            ...identity,
            ...(timeout === undefined
              ? {}
              : { config: { ...identity.config, timeout_ms: timeout } }),
            semantic,
          });
          const candidate = await readJson<CachedCall>(
            join(directory, `${candidateKey}.json`),
          );
          if (!candidate || candidate.transport_error) continue;
          const { stage: _cachedStage, ...cachedSemantic } = candidate.request;
          if (
            candidate.version !== 1 ||
            candidate.key !== candidateKey ||
            hash(cachedSemantic) !== hash(semantic)
          )
            throw new Error("Invalid shared model-cache identity");
          key = candidateKey;
          cached = candidate;
          break;
        }
      }
      // v1 summary migration: removing maxItems=32 does not require paying to
      // regenerate an otherwise valid answer to identical instructions/data.
      // Keep the original cache key and exact request, so usage is not doubled.
      const properties = request.schema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (
        !cached &&
        properties?.facts?.type === "array" &&
        properties.facts.maxItems === undefined &&
        properties.summary &&
        properties.unresolved &&
        Object.keys(properties).length === 3
      ) {
        const legacySchema = {
          ...request.schema,
          properties: {
            ...properties,
            facts: { maxItems: 32, ...properties.facts },
          },
        };
        const legacyKey = hash({
          ...identity,
          semantic: { ...semantic, schema: legacySchema },
        });
        const legacyPath = join(this.cacheDirectory, `${legacyKey}.json`);
        const legacy = await readJson<CachedCall>(legacyPath);
        if (
          legacy &&
          !legacy.transport_error &&
          schema.safeParse(normalizeRefs(legacy.response.value)).success
        ) {
          key = legacyKey;
          path = legacyPath;
          cached = legacy;
        }
      }
      if (cached && (cached.key !== key || cached.version !== 1))
        throw new Error("Invalid model-cache identity");
      // Count the actual system and serialized user content, plus a framing reserve.
      const estimated =
        cached?.estimated_input_tokens ??
        this.tokenizer.count(request.system) +
          this.tokenizer.count(
            JSON.stringify({
              task,
              instruction: request.instruction,
              output_schema: request.schema,
              data: request.data,
            }),
          ) +
          128;
      if (estimated > this.options.inputTokens)
        throw new Error(
          `${stage}: ${estimated} estimated prompt tokens exceed ${this.options.inputTokens}. No source was truncated.`,
        );
      const started = Date.now();
      let response: ModelResponse | undefined;
      try {
        if (cached?.transport_error)
          throw new ModelResponseError(cached.transport_error, cached.response);
        response = cached?.response ?? (await this.model.complete(request));
        // Save paid responses before validation: a repair must not hide their cost.
        if (!cached)
          await atomicJson(path, {
            version: 1,
            key,
            created_at: new Date().toISOString(),
            elapsed_ms: Date.now() - started,
            request,
            response,
            estimated_input_tokens: estimated,
          } satisfies CachedCall);
        const value = schema.parse(normalizeRefs(response.value));
        for (const ref of referencedIds(value))
          if (!allowed.has(ref))
            throw new Error(
              `Citation ${ref} is absent from this call's input.`,
            );
        await this.record({
          key,
          stage,
          cache_hit: Boolean(cached),
          elapsed_ms: Date.now() - started,
          estimated_input_tokens: estimated,
          input_tokens: response.input_tokens,
          output_tokens: response.output_tokens,
          cache_hit_tokens: response.cache_hit_tokens ?? 0,
          response_model: response.response_model ?? null,
          ...(response.response_transport
            ? { response_transport: response.response_transport }
            : {}),
          ok: true,
        });
        if (!cached)
          this.progress(
            `${this.name}: ${stage} (${response.input_tokens ?? "?"} in / ${response.output_tokens ?? "?"} out)`,
          );
        return value;
      } catch (error) {
        if (error instanceof ModelResponseError) {
          response = error.response;
          if (!cached)
            await atomicJson(path, {
              version: 1,
              key,
              created_at: new Date().toISOString(),
              elapsed_ms: Date.now() - started,
              request,
              response,
              estimated_input_tokens: estimated,
              transport_error: error.message,
            } satisfies CachedCall);
        }
        await this.record({
          key,
          stage,
          cache_hit: Boolean(cached),
          elapsed_ms: Date.now() - started,
          estimated_input_tokens: estimated,
          input_tokens:
            response?.input_tokens ??
            (error instanceof ModelQuotaError ||
            error instanceof ModelBudgetError
              ? 0
              : null),
          output_tokens:
            response?.output_tokens ??
            (error instanceof ModelQuotaError ||
            error instanceof ModelBudgetError
              ? 0
              : null),
          cache_hit_tokens: response?.cache_hit_tokens ?? 0,
          response_model: response?.response_model ?? null,
          ...(response?.response_transport
            ? { response_transport: response.response_transport }
            : {}),
          ok: false,
          ...(error instanceof ModelQuotaError
            ? { provider_rejection: "quota" as const }
            : {}),
          ...(error instanceof ModelBudgetError
            ? { local_rejection: "budget" as const }
            : {}),
        });
        if (!response || attempt === maxRepairs) throw error;
        repairData = {
          attempt: attempt + 1,
          previous_output: response.value,
          validation_error:
            error instanceof Error ? error.message : "invalid output",
          allowed_source_ids: [...allowed],
        };
        correction = `\nRepair attempt ${attempt + 1}: the previous output is included as untrusted repair data. Correct its validation errors, including array types and maximum item counts. Only cite IDs from original_input. Return the complete corrected JSON object, not a patch.`;
      }
    }
    throw new Error("Unreachable model loop");
  }
  private async record(call: CallRecord) {
    this.calls.push(call);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(
      join(this.directory, "calls.jsonl"),
      `${JSON.stringify(call)}\n`,
      { mode: 0o600 },
    );
  }
}

/** Lossless syntax normalization only: one source ID is the same singleton citation list. */
export function normalizeRefs(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeRefs);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "refs" && typeof child === "string" && /^s\d+$/.test(child)
        ? [child]
        : normalizeRefs(child),
    ]),
  );
}

/** Pack complete records. Never slice a record or discard an overflow tail. */
export function packTokens<T>(
  items: T[],
  tokenizer: TokenCounter,
  budget: number,
  serialize: (item: T) => unknown = (item) => item,
): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  let size = 2;
  for (const item of items) {
    const count = tokenizer.count(JSON.stringify(serialize(item))) + 2;
    if (count > budget)
      throw new Error(
        `One record needs ${count} tokens, exceeding the ${budget}-token packing budget.`,
      );
    if (group.length && size + count > budget) {
      groups.push(group);
      group = [];
      size = 2;
    }
    group.push(item);
    size += count;
  }
  if (group.length) groups.push(group);
  return groups;
}
