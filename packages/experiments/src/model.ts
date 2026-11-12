import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";

export type Task =
  | "outline"
  | "summarize"
  | "score"
  | "card"
  | "link"
  | "segment"
  | "attempts"
  | "membership"
  | "decisions"
  | "discover"
  | "revise"
  | "reconstruct"
  | "write"
  | "verify";
export type ModelRequest = {
  task: Task;
  stage: string;
  system: string;
  instruction: string;
  data: unknown;
  schema: Record<string, unknown>;
};
export type ModelResponse = {
  value: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens?: number;
  response_model?: string;
  response_transport?: "json" | "sse";
};
export interface Model {
  readonly name: string;
  readonly model: string;
  readonly demo: boolean;
  readonly configuration?: Record<string, string | number>;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** A completed HTTP response whose structured output failed. Preserve its billable usage. */
export class ModelResponseError extends Error {
  constructor(
    message: string,
    readonly response: ModelResponse,
  ) {
    super(message);
  }
}

/** Explicit account-quota rejection; retrying the same request cannot fix it. */
export class ModelQuotaError extends Error {
  constructor(
    readonly scope: "monthly" | "weekly" | "5-hour" | "balance" | "account",
  ) {
    super(
      "Kimi Code " +
        scope +
        " quota exhausted (HTTP 429). Restore quota or resume after its reset.",
    );
  }
}

/** A local budget guard rejected the request before it reached the provider. */
export class ModelBudgetError extends Error {}

export type HttpOptions = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  jsonMode?: "schema" | "object";
  apiStyle?: "openai" | "deepseek" | "kimi-code";
  reasoningEffort?: "low" | "high" | "max";
  contextTokens?: number;
  maxAttempts?: number;
};

type ChatResponse = {
  choices?: {
    finish_reason?: string;
    message?: { content?: string; refusal?: string };
    delta?: { content?: string; refusal?: string };
  }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/** Drain through the final usage event, without retaining reasoning deltas. */
async function readChatStream(response: Response): Promise<ChatResponse> {
  if (!response.body) throw new Error("Model returned an empty stream.");
  const result: ChatResponse = {};
  const message = { content: "", refusal: "" };
  const choice: NonNullable<ChatResponse["choices"]>[number] = { message };
  result.choices = [choice];
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let done = false;
  const line = (value: string) => {
    if (value.startsWith("data:")) {
      data.push(value.slice(5).trimStart());
    } else if (value === "" && data.length) {
      const event = data.join("\n");
      data = [];
      if (event === "[DONE]") {
        done = true;
        return;
      }
      let chunk: ChatResponse;
      try {
        chunk = JSON.parse(event) as ChatResponse;
      } catch {
        throw new Error("Model returned an invalid streaming event.");
      }
      if (chunk.model) result.model = chunk.model;
      if (chunk.usage) result.usage = chunk.usage;
      const part = chunk.choices?.[0];
      message.content += part?.delta?.content ?? "";
      message.refusal += part?.delta?.refusal ?? "";
      if (part?.finish_reason) choice.finish_reason = part.finish_reason;
    }
  };
  const reader = response.body.getReader();
  try {
    while (!done) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end = pending.indexOf("\n");
      while (end >= 0) {
        line(pending.slice(0, end).replace(/\r$/, ""));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
      if (chunk.done) {
        if (pending) line(pending.replace(/\r$/, ""));
        line("");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return result;
}

/** Stateless Chat Completions transport. No transcript command or tool is executed. */
export class HttpModel implements Model {
  readonly name = "openai-compatible";
  readonly demo = false;
  readonly model: string;
  private readonly url: URL;
  get configuration(): Record<string, string | number> {
    return {
      base_url: this.url.href.replace(/\/chat\/completions$/, ""),
      json_mode: this.options.jsonMode ?? "schema",
      max_output_tokens:
        this.options.maxOutputTokens ??
        (this.options.apiStyle === "kimi-code" ? 16384 : 8192),
      timeout_ms: this.options.timeoutMs ?? 120000,
      api_style: this.options.apiStyle ?? "openai",
      ...(this.options.apiStyle === "kimi-code"
        ? {
            reasoning_effort: this.options.reasoningEffort ?? "high",
            context_tokens: this.options.contextTokens ?? 262144,
          }
        : {}),
    };
  }
  constructor(private readonly options: HttpOptions) {
    if (
      options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) ||
        options.maxAttempts < 1 ||
        options.maxAttempts > 3)
    )
      throw new Error("HTTP attempts must be 1–3.");
    if (!options.model.trim())
      throw new Error("Set --model or SESSIONLORE_MODEL for the API provider.");
    this.model = options.model;
    this.url = new URL(
      `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
    );
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw new Error(
        "API base URL must not contain credentials, a query, or a fragment.",
      );
    if (
      this.url.protocol !== "https:" &&
      !(
        this.url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname)
      )
    )
      throw new Error(
        "Use HTTPS for a remote API endpoint (HTTP is allowed for localhost).",
      );
    if (this.url.hostname === "api.openai.com" && !options.apiKey)
      throw new Error(
        "Set OPENAI_API_KEY (or the environment variable named by --api-key-env).",
      );
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const responseFormat =
      this.options.jsonMode === "object" ||
      this.options.apiStyle === "deepseek" ||
      this.options.apiStyle === "kimi-code"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: "sessionlore",
              strict: true,
              schema: request.schema,
            },
          };
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        {
          role: "user",
          content: JSON.stringify({
            task: request.task,
            instruction: request.instruction,
            output_schema: request.schema,
            data: request.data,
          }),
        },
      ],
      response_format: responseFormat,
      ...(this.options.apiStyle === "deepseek"
        ? {
            max_tokens: this.options.maxOutputTokens ?? 8192,
            thinking: { type: "disabled" },
            temperature: 0.2,
          }
        : this.options.apiStyle === "kimi-code"
          ? {
              max_completion_tokens: this.options.maxOutputTokens ?? 16384,
              reasoning_effort: this.options.reasoningEffort ?? "high",
            }
          : { max_completion_tokens: this.options.maxOutputTokens ?? 8192 }),
      stream: this.options.apiStyle === "kimi-code",
      ...(this.options.apiStyle === "kimi-code"
        ? { stream_options: { include_usage: true } }
        : {}),
    };
    // The shared local tokenizer is DeepSeek's, not Kimi's. UTF-8 bytes are a
    // conservative upper bound for text BPE tokens; include framing and output.
    if (
      this.options.apiStyle === "kimi-code" &&
      Buffer.byteLength(JSON.stringify(body.messages), "utf8") +
        1024 +
        (this.options.maxOutputTokens ?? 16384) >
        (this.options.contextTokens ?? 262144)
    )
      throw new Error(
        "Kimi context safety bound exceeded. Reduce input; no source was truncated.",
      );
    let response: Response | undefined;
    // Retry only rate limits and transient server errors, never schema/auth failures.
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      response = await fetch(this.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiStyle === "kimi-code"
            ? { "User-Agent": "sessionlore/0.1.0" }
            : {}),
          ...(this.options.apiKey
            ? { Authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120000),
      });
      if (this.options.apiStyle === "kimi-code" && response.status === 429) {
        const detail = (await response
          .clone()
          .json()
          .catch(() => null)) as {
          error?: { type?: string; message?: string };
        } | null;
        const message = detail?.error?.message ?? "";
        if (
          detail?.error?.type === "exceeded_current_quota_error" ||
          /(?:monthly|weekly|5-hour) usage limit|credit balance is insufficient|Extra Usage (?:balance|limit)/i.test(
            message,
          )
        ) {
          await response.body?.cancel();
          throw new ModelQuotaError(
            /monthly/i.test(message)
              ? "monthly"
              : /weekly|7-day/i.test(message)
                ? "weekly"
                : /5-hour/i.test(message)
                  ? "5-hour"
                  : /balance/i.test(message)
                    ? "balance"
                    : "account",
          );
        }
      }
      if (
        response.ok ||
        (response.status !== 429 && response.status < 500) ||
        attempt === maxAttempts - 1
      )
        break;
      await response.body?.cancel();
      await delay(500 * 2 ** attempt);
    }
    if (!response?.ok)
      throw new Error(
        `Model HTTP ${response?.status ?? "failure"}. Check endpoint, credentials, model, JSON mode, and output-token limit.`,
      );
    const streaming = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const parsed: ChatResponse = streaming
      ? await readChatStream(response)
      : ((await response.json()) as ChatResponse);
    const choice = parsed.choices?.[0];
    const usage = {
      input_tokens: parsed.usage?.prompt_tokens ?? null,
      output_tokens: parsed.usage?.completion_tokens ?? null,
      ...((parsed.usage?.prompt_cache_hit_tokens ??
        parsed.usage?.prompt_tokens_details?.cached_tokens ??
        parsed.usage?.cached_tokens) !== undefined
        ? {
            cache_hit_tokens:
              parsed.usage?.prompt_cache_hit_tokens ??
              parsed.usage?.prompt_tokens_details?.cached_tokens ??
              parsed.usage?.cached_tokens ??
              0,
          }
        : {}),
      ...(parsed.model ? { response_model: parsed.model } : {}),
      response_transport: streaming ? ("sse" as const) : ("json" as const),
    };
    if (choice?.message?.refusal) throw new Error("Model refused the request.");
    if (choice?.finish_reason !== "stop")
      throw new ModelResponseError(
        `Model did not finish a JSON response (${choice?.finish_reason ?? "missing finish reason"}); increase --max-output-tokens if truncated.`,
        { value: choice?.message?.content ?? null, ...usage },
      );
    const content = choice.message?.content;
    if (!content)
      throw new ModelResponseError("Model returned no text content.", {
        value: null,
        ...usage,
      });
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new ModelResponseError(
        "Model returned invalid JSON. Use a model that supports JSON output.",
        { value: content, ...usage },
      );
    }
    return {
      value,
      ...usage,
    };
  }
}

export type Schema<T> = z.ZodType<T>;
