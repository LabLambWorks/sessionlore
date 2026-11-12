import { expect, it } from "vitest";
import {
  assembleInventory,
  type InventoryRecord,
  prepareInventory,
  validateInventory,
} from "../src/request-inventory.js";

const rec = (
  id: string,
  text: string,
  role = "user_request",
): InventoryRecord => ({
  id,
  text,
  role,
  thread_id: "chat",
  timestamp: "2026-01-01T00:00:00Z",
  source_refs: [id],
});
const token = { name: "test", count: (s: string) => s.length };
const item = (quote = "Make the button larger") => ({
  request: "Enlarge the button.",
  kind: "enhancement",
  area: "interface",
  scope: "focused",
  quote,
  reason: null,
  context_ids: [],
  uncertainty: null,
});
const source = rec("m1", "Make the button larger and change its label to Go.");
const batch = { id: "batch-1", target_ids: ["m1"], records: [source] };

it("covers every request and recorded answer once without promoting assistant context", () => {
  const records = [
    source,
    rec("m2", "Use a larger button?", "question"),
    rec("m3", '{"answers":{"size":{"answers":["larger"]}}}', "user_answer"),
    rec("m4", "Completed.", "assistant_report"),
  ];
  const batches = prepareInventory(records, token, 2000, 1);
  expect(batches.flatMap((b) => b.target_ids)).toEqual(["m1", "m3"]);
  expect(batches[1]!.records.map((r) => r.id)).toContain("m2");
});
it("rejects early completion and invented or repeated target IDs", () => {
  expect(() => validateInventory({ records: [] }, batch)).toThrow("target");
  expect(() =>
    validateInventory(
      { records: [{ id: "m99", items: [], no_request_reason: "Thanks" }] },
      batch,
    ),
  ).toThrow("target");
  const row = { id: "m1", items: [item()], no_request_reason: null };
  expect(() => validateInventory({ records: [row, row] }, batch)).toThrow(
    "target",
  );
});
it("retains multiple minor requests from one message and keeps implementation unchecked", () => {
  const second = {
    ...item("change its label to Go"),
    request: "Change the label to Go.",
  };
  const result = assembleInventory(
    [source],
    [
      {
        batch,
        value: {
          records: [
            { id: "m1", items: [item(), second], no_request_reason: null },
          ],
        },
      },
    ],
  );
  expect(result.items).toHaveLength(2);
  expect(result.status).toBe("complete");
  expect(
    result.items.every((i) => i.implementation_status === "not_checked"),
  ).toBe(true);
});
it("preserves later refinements rather than merging by repeated wording", () => {
  const later = {
    ...rec("m2", "Make the button larger"),
    timestamp: "2026-01-02T00:00:00Z",
  };
  const rows = [source, later];
  const b = { id: "batch-1", records: rows, target_ids: ["m1", "m2"] };
  const result = assembleInventory(rows, [
    {
      batch: b,
      value: {
        records: rows.map((r) => ({
          id: r.id,
          items: [item()],
          no_request_reason: null,
        })),
      },
    },
  ]);
  expect(result.items.map((i) => i.record_id)).toEqual(["m1", "m2"]);
});
it("requires an explicit reason for excluding a target and keeps pending coverage visible", () => {
  expect(() =>
    validateInventory(
      { records: [{ id: "m1", items: [], no_request_reason: null }] },
      batch,
    ),
  ).toThrow("no-request");
  expect(assembleInventory([source], []).coverage.pending_ids).toEqual(["m1"]);
});
it("reuses a complete response that omits an inapplicable exclusion field without mutating it", () => {
  const value = { records: [{ id: "m1", items: [item()] }] };
  const valid = validateInventory(value, batch);
  expect(valid.response.records[0]!.no_request_reason).toBeNull();
  expect(valid.normalizations).toEqual([
    {
      record_id: "m1",
      field: "no_request_reason",
      action: "missing_to_null_for_nonempty_items",
    },
  ]);
  expect(value.records[0]).not.toHaveProperty("no_request_reason");
});
it("does not invent a missing exclusion reason or replace malformed metadata", () => {
  expect(() =>
    validateInventory({ records: [{ id: "m1", items: [] }] }, batch),
  ).toThrow();
  expect(() =>
    validateInventory(
      { records: [{ id: "m1", items: [item()], no_request_reason: 42 }] },
      batch,
    ),
  ).toThrow();
});
it("flags unsupported quotations without deleting supported neighboring requests", () => {
  const result = assembleInventory(
    [source],
    [
      {
        batch,
        value: {
          records: [
            {
              id: "m1",
              items: [item(), item("Invented wording")],
              no_request_reason: null,
            },
          ],
        },
      },
    ],
  );
  expect(result.items).toHaveLength(2);
  expect(result.items[0]!.quotation_issues).toEqual([]);
  expect(result.items[1]!.quotation_issues).toEqual(["quote"]);
});
it("rejects invented reason sources and preserves the actual reason actor", () => {
  const diagnostic = rec(
    "m2",
    "The target is hard to tap.",
    "assistant_report",
  );
  const b = { ...batch, records: [source, diagnostic] };
  const value = {
    records: [
      {
        id: "m1",
        items: [
          {
            ...item(),
            reason: {
              text: "Improve tap accuracy.",
              source_id: "m2",
              quote: "hard to tap",
            },
          },
        ],
        no_request_reason: null,
      },
    ],
  };
  expect(
    assembleInventory([source, diagnostic], [{ batch: b, value }]).items[0]!
      .reason_actor,
  ).toBe("assistant_report");
  value.records[0]!.items[0]!.reason.source_id = "m99";
  expect(() => validateInventory(value, b)).toThrow("reason source");
});
it("fails on an oversized complete record instead of truncating it", () => {
  expect(() =>
    prepareInventory([rec("m1", "x".repeat(3000))], token, 1000),
  ).toThrow("Nothing truncated");
});
