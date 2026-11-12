import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KimiRunBudget, reservation } from "./kimi-run-budget.mjs";

const request = {
  task: "write",
  stage: "test",
  system: "system",
  instruction: "write",
  schema: {},
  data: "source",
};
const quota = (used = 0) => ({ limits: [{ detail: { used, limit: 100 } }] });
const fixture = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "sessionlore-budget-"));
  try {
    await run(new KimiRunBudget(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("budget persists across restarts and refuses a complete oversized request", () =>
  fixture(async (budget, directory) => {
    await budget.reserve(request, quota(), 16384);
    await budget.settle({ input_tokens: 1000, output_tokens: 1000 });
    await assert.rejects(
      new KimiRunBudget(directory).reserve(
        { ...request, data: "x".repeat(190000) },
        quota(),
        16384,
      ),
      /remaining 200,000-token/,
    );
  }));
test("eight-call cap includes all resumed invocations", () =>
  fixture(async (budget, directory) => {
    for (let i = 0; i < 8; i++) {
      await budget.reserve(request, quota(), 16384);
      await budget.settle({ input_tokens: 10, output_tokens: 10 });
    }
    await assert.rejects(
      new KimiRunBudget(directory).reserve(request, quota(), 16384),
      /call cap/,
    );
  }));
test("unknown usage and interrupted reservations fail closed", () =>
  fixture(async (budget, directory) => {
    await budget.reserve(request, quota(), 16384);
    await assert.rejects(
      new KimiRunBudget(directory).reserve(request, quota(), 16384),
      /unknown outcome/,
    );
    await budget.settle(null, "network failed");
    await assert.rejects(
      new KimiRunBudget(directory).reserve(request, quota(), 16384),
      /unknown usage/,
    );
  }));
test("quota consumption guard and missing quota fail before generation", () =>
  fixture(async (budget) => {
    await budget.reserve(request, quota(10), 16384);
    await budget.settle({ input_tokens: 10, output_tokens: 10 });
    await assert.rejects(
      budget.reserve(request, quota(25), 16384),
      /15 percentage points/,
    );
    await assert.rejects(
      budget.reserve(request, { limits: [] }, 16384),
      /Cannot verify/,
    );
  }));
test("reservation includes UTF-8 bytes, framing and the full output allowance", () => {
  assert(
    reservation({ ...request, data: "字".repeat(1000) }, 16384) >
      3000 + 1024 + 16384,
  );
});

test("an authorized call-cap amendment preserves spent tokens and other limits", () =>
  fixture(async (budget) => {
    for (let i = 0; i < 8; i++) {
      await budget.reserve(request, quota(), 16384);
      await budget.settle({ input_tokens: 100, output_tokens: 100 });
    }
    await assert.rejects(budget.reserve(request, quota(), 16384), /call cap/);
    await budget.amend(
      { calls: 12 },
      "User requested finishing the cached comparison with bounded cap increases",
    );
    assert.deepEqual(await budget.limits(), {
      tokens: 200000,
      calls: 12,
      quota_percentage_points: 15,
    });
    await budget.reserve(request, quota(), 16384);
    await budget.settle({ input_tokens: 100, output_tokens: 100 });
    await assert.rejects(
      budget.reserve({ ...request, data: "x".repeat(190000) }, quota(), 16384),
      /remaining/,
    );
  }));

test("provider counts use framing and output reserves; unknown usage cannot be cleared", () =>
  fixture(async (budget) => {
    const large = { ...request, data: "x".repeat(220000) };
    await budget.reserve(large, quota(), 16384, 10000);
    await budget.settle({ input_tokens: 10048, output_tokens: 500 });
    await assert.rejects(
      budget.reserve(request, quota(), 16384, -1),
      /Invalid provider/,
    );
    await budget.reserve(request, quota(), 16384, 100);
    await budget.settle(null, "network failure");
    await assert.rejects(
      budget.amend({ calls: 12 }, "Approved"),
      /unresolved usage/,
    );
  }));
