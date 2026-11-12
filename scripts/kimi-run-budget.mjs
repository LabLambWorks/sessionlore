import { join } from "node:path";
import {
  atomicJson,
  hash,
  readJson,
} from "../packages/experiments/dist/long/runtime.js";
import { ModelBudgetError } from "../packages/experiments/dist/model.js";

export const RESUME_LIMITS = Object.freeze({
  tokens: 200000,
  calls: 8,
  quota_percentage_points: 15,
});

// Reserve complete UTF-8 message bytes plus framing and the full output allowance.
// This is a conservative safety bound, not an exact Kimi token estimate.
export function reservation(request, maxOutputTokens) {
  const messages = [
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
  ];
  return (
    Buffer.byteLength(JSON.stringify(messages), "utf8") + 1024 + maxOutputTokens
  );
}

function usedPercent(snapshot) {
  const values = snapshot.limits
    .map(({ detail = {} }) => {
      const limit = Number(detail.limit);
      const used =
        detail.used === undefined
          ? limit - Number(detail.remaining)
          : Number(detail.used);
      return limit > 0 && Number.isFinite(used) ? (used / limit) * 100 : NaN;
    })
    .filter(Number.isFinite);
  if (!values.length)
    throw new ModelBudgetError(
      "Cannot verify quota usage. No generation sent.",
    );
  return Math.max(...values);
}

export class KimiRunBudget {
  constructor(directory) {
    this.path = join(directory, "resume-budget.json");
  }
  async limits() {
    return (await readJson(this.path))?.limits ?? RESUME_LIMITS;
  }
  async amend(changes, authorization) {
    if (!authorization?.trim())
      throw new Error("A budget amendment needs its authorization recorded");
    const state = await readJson(this.path);
    if (
      !state ||
      state.pending ||
      state.blocked?.includes("unknown") ||
      state.blocked?.includes("exceeded the conservative")
    )
      throw new Error("Inspect unresolved usage before amending a budget");
    for (const [name, value] of Object.entries(changes)) {
      if (
        !(name in RESUME_LIMITS) ||
        !Number.isInteger(value) ||
        value < state.limits[name]
      )
        throw new Error(
          "Budget amendments must explicitly increase known limits",
        );
    }
    state.amendments ??= [];
    state.amendments.push({
      at: new Date().toISOString(),
      authorization,
      previous_limits: state.limits,
      new_limits: { ...state.limits, ...changes },
      previous_block: state.blocked ?? null,
      previous_stop: state.last_stop ?? null,
      calls_at_amendment: state.calls,
      tokens_at_amendment: state.used_tokens,
    });
    state.limits = { ...state.limits, ...changes };
    state.blocked = null;
    await atomicJson(this.path, state);
  }
  async reserve(request, snapshot, maxOutputTokens, providerCount, approach) {
    const current = usedPercent(snapshot);
    const state = (await readJson(this.path)) ?? {
      created_at: new Date().toISOString(),
      limits: RESUME_LIMITS,
      quota_start_percent: current,
      used_tokens: 0,
      calls: 0,
      entries: [],
    };
    if (
      providerCount !== undefined &&
      (!Number.isInteger(providerCount) || providerCount < 0)
    )
      throw new ModelBudgetError(
        "Invalid provider token count. No generation sent.",
      );
    const tokens =
      providerCount === undefined
        ? reservation(request, maxOutputTokens)
        : providerCount + 2048 + maxOutputTokens;
    const limits = state.limits;
    const reason =
      state.blocked ||
      (state.pending && "An earlier request has an unknown outcome") ||
      (state.calls >= limits.calls &&
        `Generation call cap (${limits.calls}) reached`) ||
      (state.used_tokens + tokens > limits.tokens &&
        `The complete next request exceeds the remaining ${limits.tokens.toLocaleString("en-US")}-token resume allowance`) ||
      (current - state.quota_start_percent >= limits.quota_percentage_points &&
        `Quota use rose by ${limits.quota_percentage_points} percentage points`);
    if (reason) {
      await atomicJson(this.path, {
        ...state,
        blocked: reason,
        last_stop: {
          at: new Date().toISOString(),
          reason,
          next_stage: request.stage,
          next_reservation: tokens,
          quota_used_percent: current,
        },
      });
      throw new ModelBudgetError(
        `${reason}. No generation sent; saved work retained.`,
      );
    }
    state.calls++;
    state.pending = {
      request_hash: hash(request),
      ...(approach ? { approach } : {}),
      stage: request.stage,
      reserved_tokens: tokens,
      input_accounting:
        providerCount === undefined
          ? "UTF-8 byte bound"
          : "Kimi count_tokens + 2048 protocol reserve",
      ...(providerCount === undefined
        ? {}
        : { provider_input_tokens: providerCount }),
      started_at: new Date().toISOString(),
    };
    await atomicJson(this.path, state);
  }
  async settle(response, failure = null) {
    const state = await readJson(this.path);
    if (!state?.pending) throw new Error("Missing Kimi budget reservation");
    const known =
      Number.isInteger(response?.input_tokens) &&
      response.input_tokens >= 0 &&
      Number.isInteger(response?.output_tokens) &&
      response.output_tokens >= 0;
    const charged = known
      ? response.input_tokens + response.output_tokens
      : state.pending.reserved_tokens;
    const entry = {
      ...state.pending,
      finished_at: new Date().toISOString(),
      input_tokens: response?.input_tokens ?? null,
      output_tokens: response?.output_tokens ?? null,
      accounted_tokens: charged,
      failure,
    };
    state.used_tokens += charged;
    state.entries.push(entry);
    if (!known)
      state.blocked =
        "A request ended with unknown usage; inspect before sending anything else";
    if (charged > state.pending.reserved_tokens)
      state.blocked =
        "Provider usage exceeded the conservative reservation; inspect the bound";
    state.pending = null;
    await atomicJson(this.path, state);
  }
}
