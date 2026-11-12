import { createHash } from "node:crypto";
import type {
  IngestBatch,
  LineageEdge,
  SourcePointer,
} from "@sessionlore/contracts";
import type { Artifact } from "./schema.js";

export type Evidence = {
  id: string;
  kind: "event" | "artifact";
  thread_id: string | null;
  timestamp: string | null;
  actor: string;
  event_kind: string;
  is_human_turn: boolean;
  text: string;
  event_id: string | null;
  artifact_id: string | null;
  source: SourcePointer | { artifact_sha256: string };
  text_start: number;
  text_end: number;
};
export type Corpus = {
  evidence: Evidence[];
  lineage: LineageEdge[];
  excluded_events: { event_id: string; reason: string }[];
};
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

// Character offsets refer to the normalized text projection, not raw byte offsets.
export function corpusFromBatches(
  batches: IngestBatch[],
  artifacts: Artifact[],
  partChars: number,
): Corpus {
  const corpus: Corpus = { evidence: [], lineage: [], excluded_events: [] };
  const seen = new Set<string>();
  const logicalEvents = new Map<string, string>();
  const add = (base: Omit<Evidence, "id" | "text_start" | "text_end">) => {
    let start = 0;
    while (start < base.text.length) {
      let end = Math.min(start + partChars, base.text.length);
      if (
        end < base.text.length &&
        /[\uD800-\uDBFF]/.test(base.text[end - 1] ?? "")
      )
        end--;
      corpus.evidence.push({
        ...base,
        id: `s${corpus.evidence.length + 1}`,
        text: base.text.slice(start, end),
        text_start: start,
        text_end: end,
      });
      start = end;
    }
  };
  const orderedBatches = [...batches].sort(
    (a, b) =>
      (
        a.events.find((event) => event.timestamp)?.timestamp ?? "9999"
      ).localeCompare(
        b.events.find((event) => event.timestamp)?.timestamp ?? "9999",
      ) || a.source.source_id.localeCompare(b.source.source_id),
  );
  for (const batch of orderedBatches) {
    corpus.lineage.push(...batch.lineage);
    for (const event of batch.events) {
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      if (event.parse_warnings.includes("mirrored_message")) {
        corpus.excluded_events.push({
          event_id: event.event_id,
          reason:
            "Explicit message mirror; canonical message and raw record retained.",
        });
        continue;
      }
      if (!event.text?.trim()) {
        corpus.excluded_events.push({
          event_id: event.event_id,
          reason: "No nonempty text projection; retained in raw snapshot.",
        });
        continue;
      }
      if (event.original_event_id) {
        const key = JSON.stringify([
          event.thread_id,
          event.original_type,
          event.original_event_id,
          event.actor,
          event.event_kind,
          event.is_human_turn,
          event.text,
        ]);
        const previous = logicalEvents.get(key);
        if (previous) {
          corpus.excluded_events.push({
            event_id: event.event_id,
            reason: `Repeated logical event in a resume file; retained event ${previous}.`,
          });
          continue;
        }
        logicalEvents.set(key, event.event_id);
      }
      add({
        kind: "event",
        thread_id: event.thread_id,
        timestamp: event.timestamp,
        actor: event.actor,
        event_kind: event.event_kind,
        is_human_turn: event.is_human_turn,
        text: event.text,
        event_id: event.event_id,
        artifact_id: null,
        source: event.payload_ref,
      });
    }
  }
  corpus.lineage = [
    ...new Map(
      corpus.lineage.map((edge) => [JSON.stringify(edge), edge]),
    ).values(),
  ];
  for (const artifact of [...artifacts].sort(
    (a, b) =>
      (a.timestamp ?? "9999").localeCompare(b.timestamp ?? "9999") ||
      a.id.localeCompare(b.id),
  )) {
    add({
      kind: "artifact",
      thread_id: null,
      timestamp: artifact.timestamp,
      actor: "artifact",
      event_kind: artifact.kind,
      is_human_turn: false,
      text: `${artifact.title}\nPaths: ${artifact.paths.join(", ")}\n${artifact.text}`,
      event_id: null,
      artifact_id: artifact.id,
      source: { artifact_sha256: sha256(JSON.stringify(artifact)) },
    });
  }
  return corpus;
}

/** Compact prompt projection; the full source locator remains in corpus.json. */
export function project(evidence: Evidence[]) {
  return evidence.map(
    ({
      id,
      kind,
      thread_id,
      timestamp,
      actor,
      event_kind,
      is_human_turn,
      text,
    }) => ({
      id,
      kind,
      thread_id,
      timestamp,
      actor,
      event_kind,
      is_human_turn,
      text,
    }),
  );
}

/** Preserve turns when possible; oversized turns split at record/fragment boundaries. */
export function blocks(evidence: Evidence[], maxChars: number): Evidence[][] {
  const turns: Evidence[][] = [];
  for (const item of evidence) {
    const last = turns.at(-1);
    if (
      !last ||
      item.is_human_turn ||
      item.thread_id !== last[0]?.thread_id ||
      item.kind !== last[0]?.kind
    )
      turns.push([item]);
    else last.push(item);
  }
  const result: Evidence[][] = [];
  let current: Evidence[] = [];
  const flush = () => {
    if (current.length) result.push(current);
    current = [];
  };
  for (const turn of turns) {
    if (
      current.length &&
      JSON.stringify(project([...current, ...turn])).length > maxChars
    )
      flush();
    for (const item of turn) {
      if (
        current.length &&
        JSON.stringify(project([...current, item])).length > maxChars
      )
        flush();
      current.push(item);
    }
  }
  flush();
  return result;
}

export function tokens(text: string): string[] {
  // Unicode words plus bigrams make CJK sources searchable without a language model.
  const words = text.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  return words
    .flatMap((word) =>
      /\p{Script=Han}/u.test(word)
        ? [
            word,
            ...Array.from(word)
              .slice(1)
              .map((c, i) => `${Array.from(word)[i]}${c}`),
          ]
        : [word],
    )
    .filter((word) => word.length > 1);
}

export class SearchIndex<T extends { id: string }> {
  readonly documents: { item: T; length: number; terms: Map<string, number> }[];
  readonly frequencies = new Map<string, number>();
  readonly averageLength: number;
  constructor(items: T[], text: (item: T) => string) {
    this.documents = items.map((item) => {
      const terms = new Map<string, number>();
      const words = tokens(text(item));
      for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
      for (const word of terms.keys())
        this.frequencies.set(word, (this.frequencies.get(word) ?? 0) + 1);
      return { item, length: words.length, terms };
    });
    this.averageLength =
      this.documents.reduce((n, doc) => n + doc.length, 0) /
        (items.length || 1) || 1;
  }
  search(query: string, count: number): { item: T; score: number }[] {
    const words = unique(tokens(query));
    return this.documents
      .map((doc) => ({
        item: doc.item,
        score: words.reduce((score, word) => {
          const tf = doc.terms.get(word) ?? 0;
          const df = this.frequencies.get(word) ?? 0;
          const idf = Math.log(
            1 + (this.documents.length - df + 0.5) / (df + 0.5),
          );
          return (
            score +
            (idf * tf * 2.2) /
              (tf + 1.2 * (0.25 + (0.75 * doc.length) / this.averageLength))
          );
        }, 0),
      }))
      .filter((hit) => hit.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.item.id.localeCompare(b.item.id, "en", { numeric: true }),
      )
      .slice(0, count);
  }
}

export function referencedIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return unique(value.flatMap(referencedIds));
  const record = value as Record<string, unknown>;
  return unique(
    Object.entries(record).flatMap(([key, child]) =>
      key === "refs" && Array.isArray(child)
        ? child.filter((id): id is string => typeof id === "string")
        : referencedIds(child),
    ),
  );
}
