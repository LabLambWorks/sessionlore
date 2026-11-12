import {
  type Corpus,
  type Evidence,
  project,
  SearchIndex,
  unique,
} from "../evidence.js";
import { hash, type TokenCounter } from "./runtime.js";
import { HybridIndex } from "./search.js";

export const REQUEST_RESULT_VERSION = "request-result-v1";
export type RecordRole =
  | "user_request"
  | "user_answer"
  | "question"
  | "delivery_acknowledgement"
  | "assistant_report"
  | "tool_result"
  | "action_attempt"
  | "other";
type Event = {
  id: string;
  items: Evidence[];
  role: RecordRole;
  text: string;
  order: number;
};
type Episode = {
  id: string;
  thread_id: string | null;
  events: Event[];
  text: string;
};
export type EvidenceLink = {
  from: string;
  to: string;
  relationship:
    | "question_answer"
    | "question_delivery"
    | "action_result_candidate";
  basis: "matching_question" | "matching_answer_keys" | "adjacency_only";
};
function json(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function answers(text: string): { keys: string[]; questions: string[] } {
  const parsed = json(text);
  if (parsed?.answers && typeof parsed.answers === "object")
    return { keys: Object.keys(parsed.answers), questions: [] };
  const tagged = text.match(
    /<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/,
  );
  if (tagged) {
    try {
      const rows = JSON.parse(tagged[1]!) as {
        question?: string;
        answer?: string;
      }[];
      return {
        keys: [],
        questions: rows
          .filter((r) => typeof r.answer === "string")
          .flatMap((r) => (r.question ? [r.question] : [])),
      };
    } catch {
      /* Preserve malformed replies as ordinary source text. */
    }
  }
  return { keys: [], questions: [] };
}
export function recordRole(item: Evidence, text = item.text): RecordRole {
  const parsed = json(text);
  if (
    item.actor === "human" &&
    text.includes("<send_user_message_question_reply>")
  )
    return "user_answer";
  if (
    item.actor === "tool" &&
    parsed?.answers &&
    typeof parsed.answers === "object"
  )
    return "user_answer";
  if (item.is_human_turn) return "user_request";
  if (
    item.actor === "tool" &&
    parsed?.accepted === true &&
    Object.keys(parsed).length === 1
  )
    return "delivery_acknowledgement";
  if (item.actor === "assistant" && Array.isArray(parsed?.questions))
    return "question";
  if (item.actor === "assistant" && item.event_kind === "message")
    return "assistant_report";
  if (item.actor === "tool" && item.event_kind === "result")
    return "tool_result";
  if (item.actor === "assistant" && item.event_kind === "action")
    return "action_attempt";
  return "other";
}

/** Structural retrieval with explicit omissions. No gold IDs or expected answers. */
export class RequestResultIndex {
  readonly episodes: Episode[] = [];
  readonly eventBySource = new Map<string, Event>();
  readonly episodeBySource = new Map<string, Episode>();
  readonly links: EvidenceLink[] = [];
  readonly anchors: HybridIndex;
  readonly episodeSearch: SearchIndex<Episode>;
  private readonly order: Map<string, number>;
  constructor(
    readonly index: HybridIndex,
    readonly corpus: Corpus,
  ) {
    this.order = new Map(index.evidence.map((e, i) => [e.id, i]));
    const events = new Map<string, Event>();
    for (const [i, item] of index.evidence.entries()) {
      const key = JSON.stringify([
        item.thread_id,
        item.event_id ?? item.artifact_id ?? item.id,
      ]);
      let event = events.get(key);
      if (!event) {
        event = { id: item.id, items: [], role: "other", text: "", order: i };
        events.set(key, event);
      }
      event.items.push(item);
      this.eventBySource.set(item.id, event);
    }
    const threads = new Map<string | null, Event[]>();
    for (const event of events.values()) {
      event.items.sort((a, b) => a.text_start - b.text_start);
      event.text = event.items.map((e) => e.text).join("");
      event.role = recordRole(event.items[0]!, event.text);
      const thread = event.items[0]!.thread_id;
      const list = threads.get(thread) ?? [];
      list.push(event);
      threads.set(thread, list);
    }
    for (const [thread, list] of threads) {
      list.sort(
        (a, b) =>
          (a.items[0]!.timestamp ?? "").localeCompare(
            b.items[0]!.timestamp ?? "",
          ) || a.order - b.order,
      );
      let episode: Episode | undefined;
      const questions: Event[] = [];
      let prior: Event | undefined;
      for (const event of list) {
        if (!episode || event.role === "user_request") {
          episode = {
            id: "episode-" + event.id,
            thread_id: thread,
            events: [],
            text: "",
          };
          this.episodes.push(episode);
        }
        episode.events.push(event);
        for (const item of event.items)
          this.episodeBySource.set(item.id, episode);
        if (
          event.role === "question" ||
          (event.role === "assistant_report" && event.text.includes("?"))
        )
          questions.push(event);
        if (event.role === "user_answer") {
          const answer = answers(event.text);
          const question = [...questions].reverse().find((q) => {
            const qs = json(q.text)?.questions as
              | { id?: string; question?: string }[]
              | undefined;
            return (
              answer.questions.some(
                (s) => q.text.includes(s) || qs?.some((x) => x.question === s),
              ) || answer.keys.some((s) => qs?.some((x) => x.id === s))
            );
          });
          if (question)
            this.links.push({
              from: question.id,
              to: event.id,
              relationship: "question_answer",
              basis: answer.questions.length
                ? "matching_question"
                : "matching_answer_keys",
            });
        }
        if (event.role === "delivery_acknowledgement" && prior)
          this.links.push({
            from: prior.id,
            to: event.id,
            relationship: "question_delivery",
            basis: "adjacency_only",
          });
        // Context expansion only: adjacency does not prove a call/result identity.
        if (
          (event.role === "tool_result" ||
            event.role === "delivery_acknowledgement") &&
          prior?.role === "action_attempt"
        )
          this.links.push({
            from: prior.id,
            to: event.id,
            relationship: "action_result_candidate",
            basis: "adjacency_only",
          });
        if (event.role !== "other") prior = event;
      }
    }
    const anchorItems = index.evidence.filter((e) =>
      ["user_request", "user_answer", "question", "assistant_report"].includes(
        this.eventBySource.get(e.id)!.role,
      ),
    );
    this.anchors = new HybridIndex(
      anchorItems,
      anchorItems.map((e) => index.vectors[index.positions.get(e.id)!]!),
      index.embedder,
    );
    for (const episode of this.episodes) {
      const seen = new Set<string>();
      episode.text = episode.events
        .filter((e) =>
          ["user_request", "user_answer", "assistant_report"].includes(e.role),
        )
        .flatMap((e) => {
          const key = hash(e.text);
          if (seen.has(key)) return [];
          seen.add(key);
          return [e.text];
        })
        .join("\n");
    }
    this.episodeSearch = new SearchIndex(this.episodes, (e) => e.text);
  }

  async select(
    queries: string[],
    seeds: string[],
    tokenizer: TokenCounter,
    budget: number,
  ) {
    const rankings = await Promise.all(
      queries.map(async (query) => ({
        query,
        fragments: await this.index.search(query, 12),
        conversation: await this.anchors.search(query, 24),
        episodes: this.episodeSearch
          .search(query, 12)
          .map((hit) => ({ id: hit.item.id, score: hit.score })),
      })),
    );
    const scores = new Map<string, number>();
    const add = (id: string, score: number) =>
      scores.set(id, (scores.get(id) ?? 0) + score);
    for (const ranking of rankings) {
      ranking.episodes.forEach((hit, i) => add(hit.id, 1 / (i + 1)));
      for (const [hits, weight] of [
        [ranking.conversation, 1],
        [ranking.fragments, 0.35],
      ] as const) {
        const perEpisode = new Map<string, number>();
        hits.forEach((hit, i) => {
          const episode = this.episodeBySource.get(hit.id)!;
          perEpisode.set(
            episode.id,
            Math.max(perEpisode.get(episode.id) ?? 0, weight / (i + 1)),
          );
        });
        for (const [id, score] of perEpisode) add(id, score);
      }
    }
    const seedEpisodes = unique(
      seeds.flatMap((id) => this.episodeBySource.get(id)?.id ?? []),
    );
    const ranked = [...scores]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    const selectedIds = unique([...seedEpisodes, ...ranked]).slice(0, 6);
    const selectedEpisodes = selectedIds.map(
      (id) => this.episodes.find((e) => e.id === id)!,
    );
    const proposals = new Map<
      string,
      { priority: number; reasons: Set<string> }
    >();
    const propose = (event: Event, priority: number, reason: string) => {
      const previous = proposals.get(event.id);
      if (previous) {
        previous.priority = Math.min(previous.priority, priority);
        previous.reasons.add(reason);
      } else proposals.set(event.id, { priority, reasons: new Set([reason]) });
    };
    selectedEpisodes.forEach((episode, rank) => {
      for (const event of episode.events) {
        if (["user_request", "user_answer", "question"].includes(event.role))
          propose(event, rank, "request_and_answers");
        if (event.role === "assistant_report")
          propose(event, 10 + rank, "progress_and_outcome");
      }
      // Follow reports across the entire episode, with no elapsed-time window.
      const reports = episode.events
        .filter((e) => e.role === "assistant_report")
        .slice(-3);
      for (const report of reports) {
        propose(report, 1 + rank, "latest_report");
        const before = episode.events
          .slice(0, episode.events.indexOf(report))
          .filter((e) => e.role === "tool_result")
          .slice(-4);
        for (const event of before)
          propose(event, 20 + rank, "results_before_report");
      }
    });
    for (const id of seeds) {
      const event = this.eventBySource.get(id);
      if (event) propose(event, -1, "explicit_seed");
    }
    for (const ranking of rankings)
      ranking.fragments.forEach((hit, rank) => {
        const event = this.eventBySource.get(hit.id)!;
        propose(event, 30 + rank, "full_corpus_search");
      });
    // Follow actual question/answer links; an acknowledgement is never an answer.
    for (const link of this.links)
      if (link.relationship === "question_answer") {
        const from = this.eventBySource.get(link.from)!,
          to = this.eventBySource.get(link.to)!;
        if (proposals.has(from.id) || proposals.has(to.id)) {
          propose(from, 2, "linked_question");
          propose(to, 2, "actual_answer");
        }
      }
    for (const link of this.links)
      if (link.relationship === "action_result_candidate") {
        if (proposals.has(link.to))
          propose(
            this.eventBySource.get(link.from)!,
            60,
            "preceding_action_context",
          );
      }
    const ordered = [...proposals].sort(
      (a, b) =>
        a[1].priority - b[1].priority ||
        this.eventBySource.get(a[0])!.order -
          this.eventBySource.get(b[0])!.order,
    );
    const chosen: Evidence[] = [];
    const aliases: { kept: string; duplicate: string }[] = [];
    const seen = new Map<string, string>();
    let size = 2;
    for (const [id] of ordered) {
      const event = this.eventBySource.get(id)!;
      // Fragments stay intact; omissions from oversized events remain explicit.
      for (const item of event.items) {
        const key = hash([item.actor, item.event_kind, item.text]);
        if (seen.has(key)) {
          aliases.push({ kept: seen.get(key)!, duplicate: item.id });
          continue;
        }
        const cost = tokenizer.count(JSON.stringify(project([item])[0])) + 2;
        if (size + cost > budget) continue;
        chosen.push(item);
        seen.set(key, item.id);
        size += cost;
      }
    }
    chosen.sort(
      (a, b) =>
        (a.timestamp ?? "").localeCompare(b.timestamp ?? "") ||
        (a.thread_id ?? "").localeCompare(b.thread_id ?? "") ||
        this.order.get(a.id)! - this.order.get(b.id)!,
    );
    const included = new Set(chosen.map((e) => e.id));
    const equivalent = new Set([
      ...included,
      ...aliases.map((a) => a.duplicate),
    ]);
    return {
      evidence: chosen,
      rankings,
      estimated_tokens: size,
      aliases,
      roles: Object.fromEntries(
        chosen.map((e) => [e.id, this.eventBySource.get(e.id)!.role]),
      ),
      links: this.links.filter(
        (link) => included.has(link.from) || included.has(link.to),
      ),
      episodes: selectedEpisodes.map((episode) => ({
        id: episode.id,
        thread_id: episode.thread_id,
        score: scores.get(episode.id) ?? 0,
        source_ids: episode.events.flatMap((e) => e.items.map((s) => s.id)),
        included_ids: episode.events.flatMap((e) =>
          e.items.filter((s) => equivalent.has(s.id)).map((s) => s.id),
        ),
        missing_spine_ids: episode.events
          .filter((e) =>
            [
              "user_request",
              "user_answer",
              "question",
              "assistant_report",
            ].includes(e.role),
          )
          .flatMap((e) =>
            e.items.filter((s) => !equivalent.has(s.id)).map((s) => s.id),
          ),
      })),
      omitted_candidate_ids: ordered
        .flatMap(([id]) => this.eventBySource.get(id)!.items.map((e) => e.id))
        .filter((id) => !equivalent.has(id)),
      coverage: {
        indexed_sources: this.index.evidence.length,
        indexed_episodes: this.episodes.length,
        selected_episodes: selectedEpisodes.length,
        time_filter: null,
      },
      lineage: this.corpus.lineage.filter((edge) =>
        selectedEpisodes.some(
          (e) =>
            e.thread_id === edge.child_thread_id ||
            e.thread_id === edge.parent_thread_id,
        ),
      ),
    };
  }
}
