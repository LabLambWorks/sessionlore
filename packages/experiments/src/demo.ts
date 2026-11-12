import { referencedIds, tokens, unique } from "./evidence.js";
import type { Model, ModelRequest, ModelResponse } from "./model.js";
import type { Statement } from "./schema.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function list(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function facts(value: unknown): Statement[] {
  if (Array.isArray(value)) return value.flatMap(facts);
  const object = record(value);
  if (typeof object.text === "string" && typeof object.id === "string") {
    return [
      {
        text: `${text(object.actor) || "Source"} record: “${object.text.slice(0, 240)}${object.text.length > 240 ? "…" : ""}”`,
        refs: [object.id],
        status: "observed",
      },
    ];
  }
  if (typeof object.text === "string" && Array.isArray(object.refs))
    return [object as Statement];
  return Object.values(object).flatMap((child) =>
    child && typeof child === "object" ? facts(child) : [],
  );
}
function sampled(value: unknown, count = 6): Statement[] {
  const all = [
    ...new Map(
      facts(value).map((fact) => [JSON.stringify(fact), fact]),
    ).values(),
  ];
  if (all.length <= count) return all;
  return [...all.slice(0, count - 1), all.at(-1)!];
}
function sourceRefs(value: unknown): string[] {
  return unique([
    ...referencedIds(value),
    ...facts(value).flatMap((fact) => fact.refs),
  ]);
}
function outline(value: unknown) {
  const all = facts(value);
  const refs = sourceRefs(value);
  const size = Math.max(1, Math.ceil(refs.length / 3));
  return {
    title: "Offline demonstration of session evidence",
    sections: Array.from({ length: Math.ceil(refs.length / size) }, (_, i) => ({
      heading: `Evidence section ${i + 1}`,
      focus: all[i * size]?.text ?? "Inspect the selected source records.",
      refs: refs.slice(i * size, (i + 1) * size),
      queries: [],
    })),
  };
}

/** Deterministic transport for smoke tests, never a quality substitute for a language model. */
export class DemoModel implements Model {
  readonly name = "demo";
  readonly model = "deterministic-extractive-v1";
  readonly demo = true;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const data = record(request.data);
    const evidence = list(data.evidence);
    const all = sampled(data);
    let value: unknown;
    switch (request.task) {
      case "summarize":
      case "decisions":
      case "reconstruct":
        value = {
          summary: all.map((fact) => fact.text.slice(0, 90)).join(" "),
          facts: all,
        };
        break;
      case "outline":
        value = outline(data);
        break;
      case "score":
        value = {
          scores: evidence.map((item) => {
            const body = text(item.text).toLowerCase();
            const labels = unique([
              ...(item.is_human_turn ? ["goal"] : []),
              ...(/fail|error|blocked|bug/.test(body) ? ["obstacle"] : []),
              ...(/instead|alternative|could|consider/.test(body)
                ? ["alternative"]
                : []),
              ...(/decid|choose|switch|revert|use /.test(body)
                ? ["decision"]
                : []),
              ...(/passed|completed|result|exit code/.test(body)
                ? ["outcome"]
                : []),
            ]);
            return {
              id: item.id,
              labels: labels.length ? labels : ["unknown"],
              relevance: labels.length ? 0.8 : 0.2,
              reason: "Offline keyword heuristic; uncalibrated.",
              refs: [item.id],
            };
          }),
        };
        break;
      case "card": {
        const matching = (pattern: RegExp) =>
          sampled(
            evidence.filter((item) => pattern.test(text(item.text))),
            1,
          )[0] ?? null;
        value = {
          title: "Source-centered demonstration card",
          goal:
            sampled(
              evidence.filter((item) => item.is_human_turn),
              1,
            )[0] ?? null,
          before: all[0] ?? null,
          trigger: matching(/fail|error|blocked/i),
          alternatives: [],
          decision: matching(/decid|choose|switch|instead|use /i),
          after: all.at(-1) ?? null,
          outcome: matching(/passed|completed|exit code/i),
          open_questions: [],
        };
        break;
      }
      case "link":
        value = {
          parent_thread_id: null,
          reason: "Offline demo abstains from semantic continuation inference.",
          refs: sourceRefs(data.child).slice(0, 1),
        };
        break;
      case "segment": {
        const cards = list(data.cards);
        const size = Math.max(1, Math.ceil(cards.length / 3));
        value = {
          title: "Pivot card demonstration",
          segments: Array.from(
            { length: Math.ceil(cards.length / size) },
            (_, i) => ({
              heading: `Pivot sequence ${i + 1}`,
              focus: "Describe this contiguous group of cards.",
              card_ids: cards
                .slice(i * size, (i + 1) * size)
                .map((card) => card.id),
            }),
          ),
        };
        break;
      }
      case "attempts": {
        const attempts: { goal: string; summary: string; refs: string[] }[] =
          [];
        for (const item of evidence) {
          if (!attempts.length || item.is_human_turn)
            attempts.push({
              goal: text(item.text).slice(0, 180),
              summary: "Offline turn-based task attempt",
              refs: [],
            });
          attempts.at(-1)!.refs.push(text(item.id));
        }
        value = { attempts };
        break;
      }
      case "membership": {
        const goal = new Set(tokens(text(record(data.attempt).goal)));
        const candidate = list(data.candidates).find(
          (item) =>
            tokens(text(item.goal)).filter((word) => goal.has(word)).length /
              (goal.size || 1) >
            0.3,
        );
        value = {
          group_ids: candidate ? [candidate.id] : [],
          create_new: !candidate,
          reason:
            "Offline word-overlap heuristic; inspect real model results for semantic grouping.",
        };
        break;
      }
      case "discover": {
        const catalogue = list(data.catalogue).map((item) => ({
          ...item,
          text: text(item.preview),
          actor: "preview",
        }));
        value = outline([catalogue, data.previous_outline]);
        break;
      }
      case "revise":
        value = data.outline;
        break;
      case "write": {
        const wordBudget =
          typeof data.word_budget === "number" ? data.word_budget : 200;
        value = {
          claims: sampled(
            data.evidence,
            Math.max(1, Math.min(8, Math.floor(wordBudget / 40))),
          ),
        };
        break;
      }
      case "verify":
        value = {
          verdict: "uncertain",
          reason: "Offline demo does not perform semantic verification.",
        };
        break;
    }
    return { value, input_tokens: null, output_tokens: null };
  }
}
