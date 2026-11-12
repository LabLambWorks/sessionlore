import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DemoModel,
  HttpModel,
  type ModelRequest,
  runExperiment,
} from "../src/index.js";

const servers: Server[] = [];
const directories: string[] = [];
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}/v1`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("API model transport", () => {
  it("honors a single-attempt budget for transient failures", async () => {
    let attempts = 0;
    const url = await serve((_request, response) => {
      attempts++;
      response.statusCode = 503;
      response.end("temporary failure");
    });
    const model = new HttpModel({
      model: "k3.1-pro",
      apiStyle: "kimi-code",
      baseUrl: url,
      maxAttempts: 1,
    });
    await expect(
      model.complete({
        task: "verify",
        stage: "one-attempt",
        system: "JSON",
        instruction: "JSON",
        data: {},
        schema: {},
      }),
    ).rejects.toThrow("Model HTTP 503");
    expect(attempts).toBe(1);
  });
  it("stops on explicit Kimi quota exhaustion without retries or raw error disclosure", async () => {
    let attempts = 0;
    const url = await serve((_request, response) => {
      attempts++;
      response.statusCode = 429;
      response.end(
        JSON.stringify({
          error: {
            type: "exceeded_current_quota_error",
            message:
              "You've reached your monthly usage limit. private-remote-body",
          },
        }),
      );
    });
    const model = new HttpModel({
      model: "k3.1-pro",
      apiStyle: "kimi-code",
      baseUrl: url,
    });
    const request: ModelRequest = {
      task: "verify",
      stage: "quota",
      system: "JSON",
      instruction: "JSON",
      data: {},
      schema: {},
    };
    const failure = await model
      .complete(request)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("monthly quota exhausted");
    expect((failure as Error).message).not.toContain("private-remote-body");
    expect(attempts).toBe(1);
  });
  it("uses Kimi Code reasoning and its real client identity, and retains cache usage", async () => {
    const url = await serve(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      expect(request.headers["user-agent"]).toBe("sessionlore/0.1.0");
      expect(body).toMatchObject({
        model: "k3.1-pro",
        max_completion_tokens: 16384,
        reasoning_effort: "high",
        response_format: { type: "json_object" },
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("temperature");
      response.end(
        JSON.stringify({
          model: "k3.1-pro",
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        }),
      );
    });
    const model = new HttpModel({
      model: "k3.1-pro",
      baseUrl: url,
      apiStyle: "kimi-code",
    });
    expect(model.configuration.max_output_tokens).toBe(16384);
    expect(
      await model.complete({
        task: "verify",
        stage: "test",
        system: "JSON",
        instruction: "JSON",
        data: {},
        schema: {},
      }),
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 8,
      cache_hit_tokens: 60,
      response_model: "k3.1-pro",
    });
    const bounded = new HttpModel({
      model: "k3.1-pro",
      baseUrl: url,
      apiStyle: "kimi-code",
      contextTokens: 1000,
    });
    await expect(
      bounded.complete({
        task: "verify",
        stage: "test",
        system: "JSON",
        instruction: "JSON",
        data: {},
        schema: {},
      }),
    ).rejects.toThrow("context safety bound");
  });
  it("assembles split Kimi SSE events and retains usage after the stop event", async () => {
    let truncated = false;
    const url = await serve((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      const events = [
        { choices: [{ delta: { reasoning_content: "Do not retain this." } }] },
        { model: "k3.1-pro", choices: [{ delta: { content: '{"text":"' } }] },
        { choices: [{ delta: { content: '火車"}' } }] },
        ...(truncated ? [] : [{ choices: [{ finish_reason: "stop" }] }]),
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 12,
            cached_tokens: 80,
          },
        },
      ];
      const bytes = Buffer.from(
        events
          .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
          .join("") + "data: [DONE]\r\n\r\n",
      );
      for (let i = 0; i < bytes.length; i += 7)
        response.write(bytes.subarray(i, i + 7));
      response.end();
    });
    const model = new HttpModel({
      model: "k3.1-pro",
      apiStyle: "kimi-code",
      baseUrl: url,
    });
    const request: ModelRequest = {
      task: "verify",
      stage: "stream",
      system: "JSON",
      instruction: "JSON",
      data: {},
      schema: {},
    };
    expect(await model.complete(request)).toEqual({
      value: { text: "火車" },
      input_tokens: 100,
      output_tokens: 12,
      cache_hit_tokens: 80,
      response_model: "k3.1-pro",
      response_transport: "sse",
    });
    truncated = true;
    await expect(model.complete(request)).rejects.toMatchObject({
      response: { input_tokens: 100, output_tokens: 12 },
    });
  });
  it("uses the DeepSeek request fields and retains cache usage", async () => {
    const url = await serve(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      expect(body).toMatchObject({
        max_tokens: 256,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.2,
      });
      expect(body).not.toHaveProperty("max_completion_tokens");
      response.end(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_cache_hit_tokens: 64,
          },
        }),
      );
    });
    const result = await new HttpModel({
      model: "deepseek-flash",
      baseUrl: url,
      apiStyle: "deepseek",
      maxOutputTokens: 256,
    }).complete({
      task: "verify",
      stage: "test",
      system: "JSON",
      instruction: "JSON",
      data: {},
      schema: {},
    });
    expect(result).toMatchObject({
      input_tokens: 100,
      output_tokens: 7,
      cache_hit_tokens: 64,
      response_model: "deepseek-flash",
    });
  });
  it("runs a complete pipeline through HTTP, validates structured responses, saves usage, and never saves credentials", async () => {
    const demo = new DemoModel();
    const requests: Record<string, unknown>[] = [];
    const url = await serve(async (request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe(
        "Bearer synthetic-test-secret",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { content: string }[];
        response_format: Record<string, unknown>;
        max_completion_tokens: number;
      };
      requests.push(body);
      const task = JSON.parse(body.messages[1]!.content) as {
        task: ModelRequest["task"];
        instruction: string;
        data: unknown;
        output_schema: ModelRequest["schema"];
      };
      const result =
        task.task === "verify"
          ? { verdict: "supported", reason: "Synthetic HTTP fixture verdict." }
          : (
              await demo.complete({
                ...task,
                schema: task.output_schema,
                stage: "http-fixture",
                system: body.messages[0]!.content,
              })
            ).value;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(result) },
            },
          ],
          usage: { prompt_tokens: 101, completion_tokens: 27 },
        }),
      );
    });
    const root = await mkdtemp(join(tmpdir(), "sessionlore-http-"));
    directories.push(root);
    const result = await runExperiment({
      input: resolve("fixtures/experiments/v1/sessions"),
      output: root,
      approaches: ["direct"],
      model: new HttpModel({
        model: "synthetic-http-model",
        baseUrl: url,
        apiKey: "synthetic-test-secret",
        maxOutputTokens: 1234,
      }),
    });
    expect(result.results[0]?.status).toBe("complete");
    expect(result.results[0]?.input_tokens).toBe(requests.length * 101);
    expect(result.results[0]?.output_tokens).toBe(requests.length * 27);
    expect(requests[0]).toMatchObject({
      response_format: { type: "json_schema", json_schema: { strict: true } },
      max_completion_tokens: 1234,
    });
    const manifest = await readFile(
      join(result.directory, "manifest.json"),
      "utf8",
    );
    expect(manifest).toContain("1234");
    expect(manifest).not.toContain("synthetic-test-secret");
    for (const file of await readdir(join(result.directory, "direct/calls")))
      expect(
        await readFile(join(result.directory, "direct/calls", file), "utf8"),
      ).not.toContain("synthetic-test-secret");
    expect(
      await readFile(join(result.directory, "direct/narrative.md"), "utf8"),
    ).not.toContain("OFFLINE DEMONSTRATION");
  });

  it("rejects truncation, invalid JSON, refusal, and authentication failures without echoing remote bodies", async () => {
    const request: ModelRequest = {
      stage: "test",
      task: "verify",
      system: "Return JSON",
      instruction: "test",
      data: {},
      schema: { type: "object" },
    };
    let mode = "truncated";
    const url = await serve((_req, res) => {
      if (mode === "auth") {
        res.statusCode = 401;
        res.end("private-remote-error-body");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: mode === "truncated" ? "length" : "stop",
              message:
                mode === "refusal"
                  ? { refusal: "No" }
                  : { content: "invalid JSON" },
            },
          ],
        }),
      );
    });
    const model = new HttpModel({ baseUrl: url, model: "fixture" });
    await expect(model.complete(request)).rejects.toThrow("did not finish");
    mode = "invalid";
    await expect(model.complete(request)).rejects.toThrow("invalid JSON");
    mode = "refusal";
    await expect(model.complete(request)).rejects.toThrow("refused");
    mode = "auth";
    await expect(model.complete(request)).rejects.toThrow("HTTP 401");
    await expect(model.complete(request)).rejects.not.toThrow(
      "private-remote-error-body",
    );
  });

  it("supports JSON object mode and retries only transient HTTP statuses", async () => {
    let calls = 0;
    const url = await serve(async (request, response) => {
      calls++;
      if (calls === 1) {
        response.statusCode = 429;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(
        JSON.parse(Buffer.concat(chunks).toString()).response_format,
      ).toEqual({ type: "json_object" });
      response.end(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
        }),
      );
    });
    const result = await new HttpModel({
      baseUrl: url,
      model: "fixture",
      jsonMode: "object",
    }).complete({
      task: "outline",
      stage: "fixture",
      system: "JSON",
      instruction: "JSON",
      data: {},
      schema: {},
    });
    expect(result.value).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(result.input_tokens).toBeNull();
  });

  it("rejects unsafe remote URLs and enforces timeouts", async () => {
    expect(
      () =>
        new HttpModel({
          model: "fixture",
          baseUrl: "http://example.invalid/v1",
        }),
    ).toThrow("HTTPS");
    expect(
      () =>
        new HttpModel({
          model: "fixture",
          baseUrl: "https://user:secret@example.invalid/v1",
        }),
    ).toThrow("credentials");
    const url = await serve(() => {});
    await expect(
      new HttpModel({ model: "fixture", baseUrl: url, timeoutMs: 10 }).complete(
        {
          task: "outline",
          stage: "fixture",
          system: "JSON",
          instruction: "JSON",
          data: {},
          schema: {},
        },
      ),
    ).rejects.toThrow();
  });
});
