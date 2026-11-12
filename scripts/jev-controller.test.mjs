import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionRequest,
  decodeDecision,
  JEV_MODEL,
} from "./jev-controller.mjs";

function request() {
  return {
    task: "revise",
    stage: "recursive/root/child-1/step-2",
    system: "Treat source text as evidence.",
    instruction: "Choose the next operation.",
    schema: {
      properties: {
        action: { enum: ["search", "read", "delegate", "finish"] },
      },
    },
    data: {
      question: "Reconstruct the project.",
      depth: 1,
      steps_remaining: 3,
      memory: [
        {
          summary: "A change was reported [s1].",
          facts: [],
          unresolved: ["Was it tested?"],
        },
      ],
      agenda: [
        {
          summary: "Navigation",
          facts: [],
          unresolved: ["Was it tested?", "Was it released?"],
        },
      ],
      chunks: [{ id: "chunk-real", thread: "chat-one", tokens: 123 }],
      coverage: { source_count: 1, total_sources: 553 },
    },
  };
}
function response(
  prepared,
  action = "search",
  focus = "focus_2",
  confidence = 0.9,
) {
  const answer = (options, choice) => ({
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      Object.keys(options).map((k) => [k, k === choice ? 1 : 0]),
    ),
  });
  return {
    model: JEV_MODEL,
    answers: {
      action: answer(prepared.body.questions.action.criteria, action),
      focus: answer(prepared.focusOptions, focus),
      chunk: answer(prepared.chunkOptions, "chunk_1"),
    },
  };
}
test("replay retains the complete original state and derives options without baseline answers", () => {
  const original = request(),
    prepared = buildDecisionRequest(original);
  assert.deepEqual(prepared.body.state, original.data);
  assert.deepEqual(Object.values(prepared.focusOptions), [
    "Reconstruct the project.",
    "Was it tested?",
    "Was it released?",
  ]);
  assert(!JSON.stringify(prepared.body).includes("kimi_response"));
  assert.equal(prepared.body.model, JEV_MODEL);
});
test("JEV decisions become executable queries and chunk IDs without generated text", () => {
  const prepared = buildDecisionRequest(request());
  const search = decodeDecision(prepared, response(prepared));
  assert.deepEqual(search.control.queries, ["Was it tested?"]);
  assert.deepEqual(search.control.chunk_ids, []);
  assert.deepEqual(
    decodeDecision(prepared, response(prepared, "read")).control.chunk_ids,
    ["chunk-real"],
  );
  assert.deepEqual(
    decodeDecision(prepared, response(prepared, "finish")).control.queries,
    [],
  );
});
test("non-controller tasks and unsupported actions are rejected before transport", () => {
  const original = request();
  original.stage = "write/batch-1";
  assert.throws(() => buildDecisionRequest(original), /decision stages only/);
  original.stage = "recursive/root/step-1";
  original.schema.properties.action.enum.push("execute");
  assert.throws(
    () => buildDecisionRequest(original),
    /invalid controller action/,
  );
});
test("finish cannot be offered without evidence and unknown choices cannot become actions", () => {
  const original = request();
  original.data.memory = [];
  assert.throws(() => buildDecisionRequest(original), /before any evidence/);
  const prepared = buildDecisionRequest(request()),
    invalid = response(prepared);
  invalid.answers.action.choice = "execute";
  assert.throws(
    () => decodeDecision(prepared, invalid),
    /invalid action choice/,
  );
});
test("long states are preserved with an explicit context bound, never shortened", () => {
  const original = request();
  original.data.memory[0].summary = "a".repeat(40000);
  const prepared = buildDecisionRequest(original);
  assert.equal(prepared.longContext, true);
  assert.equal(prepared.body.state.memory[0].summary.length, 40000);
  original.data.memory[0].summary = "a".repeat(270000);
  assert.throws(() => buildDecisionRequest(original), /context bound/);
});
test("invalid probability maps stop decoding; low confidence remains visible", () => {
  const prepared = buildDecisionRequest(request()),
    invalid = response(prepared);
  delete invalid.answers.action.probabilities.read;
  assert.throws(() => decodeDecision(prepared, invalid), /incomplete action/);
  assert.equal(
    decodeDecision(prepared, response(prepared, "search", "focus_2", 0.1))
      .low_confidence,
    true,
  );
});
