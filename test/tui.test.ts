import { describe, expect, test } from "bun:test";
import type { Context, KeymapCommand, SlotClaim, ToastOptions } from "@opencode/plugin/tui/context";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender, type JSX } from "@opentui/solid";
import { Show, createComponent, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { version } from "../package.json";
import plugin, { costColorForCny, resolveCostOptions } from "../tui";
import type {
  SessionMessageAssistant as AssistantMessage,
  SessionMessageInfo,
  ModelInfo as Model,
  OpenCodeClient,
  SessionInfo as Session,
} from "@opencode/client";
import {
  combineCosts,
  computeCostBreakdown,
  computeTotals,
  detectCacheMisses,
  estimateCost,
  estimateCostByProvider,
  estimateDeepSeekMessageCostCny,
  fetchSessionMessages,
  fetchDescendants,
  getChinaHolidayCalendar,
  isDeepSeekPeakTime,
  MissingHolidayCalendarError,
  sumSessions,
} from "../usage";

function assistant(id: string): AssistantMessage {
  return {
    id,
    type: "assistant",
    time: { created: 0 },
    model: { id: "model", providerID: "provider" },
    agent: "build",
    content: [],
    cost: 0.5,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
  };
}

function session(id: string): Session {
  return {
    id,
    projectID: "project",
    location: { directory: "/" },
    title: id,
    cost: 1,
    tokens: {
      input: 50,
      output: 10,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
    time: { created: 0, updated: 0 },
  };
}

function pricedModel(
  id: string,
  providerID: string,
  cost: Model["cost"][number],
): Model {
  return {
    id,
    modelID: id,
    providerID,
    cost: [cost],
  } as Model;
}

function cacheRequest(id: string, created: number, tokens: { input?: number; read?: number; write?: number }): AssistantMessage {
  return {
    ...assistant(id),
    time: { created, completed: created + 1 },
    tokens: { input: tokens.input ?? 0, output: 0, reasoning: 0, cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 } },
  };
}

function clientFor(
  children: Record<string, Session[]>,
  messages: Record<string, SessionMessageInfo[]>,
): OpenCodeClient {
  return {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
      list: async ({ parentID }: { parentID: string }) => ({
        data: children[parentID] ?? [],
        cursor: {},
      }),
    },
    message: {
      list: async ({ sessionID }: { sessionID: string }) => ({
        data: messages[sessionID] ?? [],
        cursor: {},
      }),
    },
  } as unknown as OpenCodeClient;
}

function storageFor(saved: Record<string, object>) {
  return {
    store<Value extends object>(key: string, { initial }: { initial: Value }) {
      const [state, setState] = createStore(structuredClone((saved[key] ?? initial) as Value));
      return [state, async (mutation: (draft: Value) => void) => {
        setState(produce(mutation));
        saved[key] = structuredClone(unwrap(state));
      }] as const;
    },
  };
}

describe("token aggregation", () => {
  test("sums assistant messages and descendant session aggregates", () => {
    const root = computeTotals([assistant("root-1")]);
    const descendants = sumSessions([session("child")], 2);

    expect(root).toMatchObject({ input: 100, output: 20, turns: 1, cost: 0.5 });
    expect(descendants).toMatchObject({ input: 50, output: 10, turns: 2, cost: 1 });
  });
});

describe("cost estimation", () => {
  test("uses the same token categories and per-million rates as OpenCode", () => {
    const message = assistant("priced");
    message.cost = 0;
    message.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(estimateCost([message], [model])).toBeCloseTo(
      0.0006855,
    );
  });

  test("finds API pricing across providers for quota-backed model aliases", () => {
    const message = assistant("quota");
    message.cost = 0;
    message.model = { id: "claude-opus-4.6", providerID: "github-copilot" };
    const quotaModel = pricedModel(message.model.id, message.model.providerID, {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    const apiModel = pricedModel("claude-opus-4-6", "anthropic", {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      estimateCost(
        [message],
        [
          quotaModel,
          apiModel,
        ],
      ),
    ).toBeGreaterThan(0);
  });

  test("combines reported and estimated costs into one mixed total", () => {
    const reported = assistant("reported");
    const quota = assistant("quota");
    quota.cost = 0;
    quota.model = { id: "claude-opus-4-6", providerID: "anthropic" };
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(
      combineCosts(reported.cost!, [reported, quota], [model]),
    ).toEqual({ cost: 0.5006855, mode: "mixed" });
  });

  test("marks a fully estimated total", () => {
    const quota = assistant("quota");
    quota.cost = 0;
    const model = pricedModel(quota.model.id, quota.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0, [quota], [model])).toEqual({
      cost: 0.0006855,
      mode: "estimated",
    });
  });

  test("does not estimate messages with an omitted cost", () => {
    const message = assistant("missing");
    delete (message as { cost?: number }).cost;
    const model = pricedModel(message.model.id, message.model.providerID, {
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });

    expect(combineCosts(0.25, [message], [model])).toEqual({
      cost: 0.25,
      mode: "reported",
    });
  });

  test("uses context tiers only above their threshold", () => {
    const message = assistant("tiered");
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    model.cost.push({
      tier: { type: "context", size: 112 },
      input: 2, output: 2, cache: { read: 2, write: 2 },
    });
    expect(estimateCost([message], [model])).toBeCloseTo(0.000137);
    message.tokens!.input += 1;
    expect(estimateCost([message], [model])).toBeCloseTo(0.000276);
  });

  test("skips unfinished assistant messages without tokens", () => {
    const message = assistant("unfinished");
    delete message.tokens;
    const model = pricedModel("model", "provider", {
      input: 1, output: 1, cache: { read: 1, write: 1 },
    });
    expect(estimateCost([message], [model])).toBe(0);
    expect(computeTotals([message])).toMatchObject({ input: 0, turns: 1 });
  });
});

describe("cost display options", () => {
  test("uses defaults and falls back independently for invalid values", () => {
    expect(resolveCostOptions(undefined)).toMatchObject({ usdMultiplier: 1, rechargeCnyPerUsd: 7.2 });
    expect(resolveCostOptions({
      usdMultiplier: -1,
      rechargeCnyPerUsd: Number.NaN,
    })).toMatchObject({ usdMultiplier: 1, rechargeCnyPerUsd: 7.2 });
    expect(resolveCostOptions({
      usdMultiplier: Number.POSITIVE_INFINITY,
      rechargeCnyPerUsd: "7.2",
    })).toMatchObject({ usdMultiplier: 1, rechargeCnyPerUsd: 7.2 });
    expect(resolveCostOptions({
      usdMultiplier: 1.5,
      rechargeCnyPerUsd: -0.1,
    })).toMatchObject({ usdMultiplier: 1.5, rechargeCnyPerUsd: 7.2 });
    expect(resolveCostOptions({
      usdMultiplier: -1,
      rechargeCnyPerUsd: 8,
    })).toMatchObject({ usdMultiplier: 1, rechargeCnyPerUsd: 8 });
    const options = {
      usdMultiplier: 2,
      rechargeCnyPerUsd: 8,
      providers: {
        alpha: { usdMultiplier: 1.25 },
        beta: { rechargeCnyPerUsd: 6 },
        Alpha: { usdMultiplier: 9, rechargeCnyPerUsd: 9 },
        invalid: { usdMultiplier: -3, rechargeCnyPerUsd: Number.POSITIVE_INFINITY },
      },
    };
    expect(resolveCostOptions(options, "alpha")).toMatchObject({ usdMultiplier: 1.25, rechargeCnyPerUsd: 8 });
    expect(resolveCostOptions(options, "beta")).toMatchObject({ usdMultiplier: 2, rechargeCnyPerUsd: 6 });
    expect(resolveCostOptions(options, "Alpha")).toMatchObject({ usdMultiplier: 9, rechargeCnyPerUsd: 9 });
    expect(resolveCostOptions(options, "ALPHA")).toMatchObject({ usdMultiplier: 2, rechargeCnyPerUsd: 8 });
    expect(resolveCostOptions(options, "invalid")).toMatchObject({ usdMultiplier: 2, rechargeCnyPerUsd: 8 });
  });

  test("resolves native currency and pricing mode at provider scope", () => {
    const options = {
      currency: "USD",
      pricingMode: "standard",
      providers: {
        deepseek: { currency: "CNY", pricingMode: "deepseek-schedule" },
      },
    };
    const deepseek = resolveCostOptions(options, "deepseek");
    expect(deepseek.currency).toBe("CNY");
    expect(deepseek.pricingMode).toBe("deepseek-schedule");
    const other = resolveCostOptions(options, "other");
    expect(other.currency).toBe("USD");
    expect(other.pricingMode).toBe("standard");
  });
});

describe("cost display colors", () => {
  test("uses final CNY boundaries for info, warning, and error", () => {
    const colors = {
      info: RGBA.fromHex("#111111"),
      warning: RGBA.fromHex("#222222"),
      error: RGBA.fromHex("#333333"),
    };

    expect(costColorForCny(4.99, colors)).toBe(colors.info);
    expect(costColorForCny(5, colors)).toBe(colors.warning);
    expect(costColorForCny(19.99, colors)).toBe(colors.warning);
    expect(costColorForCny(20, colors)).toBe(colors.error);
  });
});

describe("multi-provider cost aggregation", () => {
  test("weights reconciled root and subagent reported costs by exact provider", () => {
    const rootMessage = assistant("root-reported");
    rootMessage.model = { providerID: "alpha", id: "model-a" };
    rootMessage.cost = 1.5;
    const childMessage = assistant("child-reported");
    childMessage.model = { providerID: "beta", id: "model-b" };
    childMessage.cost = 2.5;
    const breakdown = computeCostBreakdown(
      [{ id: "root", cost: 3 }, { id: "child", cost: 4 }],
      [rootMessage, childMessage],
      [],
      {
        usdMultiplier: 2,
        rechargeCnyPerUsd: 8,
        providers: {
          alpha: { usdMultiplier: 1.2, rechargeCnyPerUsd: 7 },
          beta: { usdMultiplier: 3, rechargeCnyPerUsd: 6 },
        },
      },
      [
        { sessionID: "root", messages: [rootMessage] },
        { sessionID: "child", messages: [childMessage] },
      ],
    );

    expect(breakdown).toMatchObject({
      cost: 7,
      mode: "reported",
      reportedCost: 7,
      estimatedCost: 0,
      weightedUsd: 15.3,
      cny: 105.6,
      reportedByProvider: { alpha: 1.5, beta: 2.5 },
      unattributedReportedCost: 3,
    });
  });

  test("adds a shortfall as unattributed cost and prevents message overcount", () => {
    const first = assistant("alpha-message");
    first.model = { providerID: "alpha", id: "model-a" };
    first.cost = 2;
    const second = assistant("beta-message");
    second.model = { providerID: "beta", id: "model-b" };
    second.cost = 2;
    const options = {
      usdMultiplier: 1.5,
      rechargeCnyPerUsd: 7,
      providers: { alpha: { usdMultiplier: 2, rechargeCnyPerUsd: 5 } },
    };

    const delta = computeCostBreakdown([{ cost: 6 }], [first], [], options);
    expect(delta).toMatchObject({
      cost: 6,
      weightedUsd: 10,
      cny: 62,
      reportedByProvider: { alpha: 2 },
      unattributedReportedCost: 4,
    });

    const overcount = computeCostBreakdown([{ cost: 3 }], [first, second], [], options);
    expect(overcount).toMatchObject({
      cost: 3,
      weightedUsd: 4.5,
      cny: 31.5,
      reportedByProvider: {},
      unattributedReportedCost: 3,
    });
  });

  test("reconciles root and child costs independently", () => {
    const rootMessage = assistant("root-overcount");
    rootMessage.model = { providerID: "alpha", id: "model-a" };
    rootMessage.cost = 2;
    const childMessage = assistant("child-valid");
    childMessage.model = { providerID: "beta", id: "model-b" };
    childMessage.cost = 99;
    const options = {
      usdMultiplier: 1,
      rechargeCnyPerUsd: 7,
      providers: {
        alpha: { usdMultiplier: 10, rechargeCnyPerUsd: 10 },
        beta: { usdMultiplier: 2, rechargeCnyPerUsd: 5 },
      },
    };

    const rootOvercount = computeCostBreakdown(
      [{ id: "root", cost: 1 }, { id: "child", cost: 100 }],
      [rootMessage, childMessage],
      [],
      options,
      [
        { sessionID: "root", messages: [rootMessage] },
        { sessionID: "child", messages: [childMessage] },
      ],
    );
    expect(rootOvercount).toMatchObject({
      cost: 101,
      reportedByProvider: { beta: 99 },
      unattributedReportedCost: 2,
      weightedUsd: 200,
      cny: 1004,
    });

    const childOvercount = computeCostBreakdown(
      [{ id: "root", cost: 100 }, { id: "child", cost: 1 }],
      [rootMessage, childMessage],
      [],
      options,
      [
        { sessionID: "root", messages: [rootMessage] },
        { sessionID: "child", messages: [childMessage] },
      ],
    );
    expect(childOvercount).toMatchObject({
      cost: 101,
      reportedByProvider: { alpha: 2 },
      unattributedReportedCost: 99,
      weightedUsd: 119,
      cny: 893,
    });
  });

  test("estimates zero-cost messages under their original provider", () => {
    const first = assistant("alpha-estimate");
    first.model = { providerID: "alpha", id: "model-a" };
    first.cost = 0;
    const second = assistant("beta-estimate");
    second.model = { providerID: "beta", id: "model-b" };
    second.cost = 0;
    const models = [
      pricedModel("model-a", "alpha", { input: 1, output: 1, cache: { read: 0, write: 0 } }),
      pricedModel("model-b", "beta", { input: 2, output: 2, cache: { read: 0, write: 0 } }),
    ];
    const options = {
      usdMultiplier: 2,
      rechargeCnyPerUsd: 7,
      providers: {
        alpha: { usdMultiplier: 3, rechargeCnyPerUsd: 5 },
        beta: { usdMultiplier: 4, rechargeCnyPerUsd: 6 },
      },
    };

    expect(estimateCostByProvider([first, second], models)).toEqual({
      alpha: 0.000125,
      beta: 0.00025,
    });
    expect(computeCostBreakdown([{ cost: 0 }], [first, second], models, options)).toMatchObject({
      cost: 0.000375,
      mode: "estimated",
      weightedUsd: 0.001375,
      cny: 0.007875,
      estimatedByProvider: { alpha: 0.000125, beta: 0.00025 },
    });
  });
});

describe("DeepSeek native-CNY schedule pricing", () => {
  const scheduleOptions = {
    providers: { deepseek: { currency: "CNY", pricingMode: "deepseek-schedule" } },
  };
  const at = (iso: string) => Date.parse(iso);

  function deepseekMessage(id: string, modelID = "deepseek-flash", created = at("2026-01-05T01:00:00Z")) {
    const message = assistant(id);
    message.model = { providerID: "deepseek", id: modelID };
    message.time = { created };
    message.cost = 999;
    message.tokens = {
      input: 1_000_000,
      output: 100_000,
      reasoning: 50_000,
      cache: { read: 100_000, write: 500_000 },
    };
    return message;
  }

  test("uses the annual holiday calendar and treats every weekend as off-peak", () => {
    expect(getChinaHolidayCalendar(2026)).toMatchObject({
      holidays: expect.arrayContaining([
        "2026-01-01", "2026-02-23", "2026-04-04", "2026-05-05",
        "2026-06-19", "2026-09-27", "2026-10-07",
      ]),
      makeupWorkdays: expect.arrayContaining(["2026-01-04", "2026-02-14", "2026-02-28"]),
    });
    expect(isDeepSeekPeakTime(at("2026-02-16T01:00:00Z"))).toBe(false); // Spring Festival
    expect(isDeepSeekPeakTime(at("2026-01-04T02:00:00Z"))).toBe(false); // Sunday makeup workday
    expect(isDeepSeekPeakTime(at("2026-02-14T02:00:00Z"))).toBe(false); // Saturday makeup workday
    expect(isDeepSeekPeakTime(at("2026-01-05T01:00:00Z"))).toBe(true); // Monday, 09:00 Beijing
  });

  test("uses Beijing time and left-closed/right-open peak boundaries", () => {
    expect(isDeepSeekPeakTime(at("2026-01-05T00:59:59Z"))).toBe(false); // 08:59:59
    expect(isDeepSeekPeakTime(at("2026-01-05T01:00:00Z"))).toBe(true); // 09:00
    expect(isDeepSeekPeakTime(at("2026-01-05T03:59:59Z"))).toBe(true); // 11:59:59
    expect(isDeepSeekPeakTime(at("2026-01-05T04:00:00Z"))).toBe(false); // 12:00
    expect(isDeepSeekPeakTime(at("2026-01-05T06:00:00Z"))).toBe(true); // 14:00
    expect(isDeepSeekPeakTime(at("2026-01-05T09:59:59Z"))).toBe(true); // 17:59:59
    expect(isDeepSeekPeakTime(at("2026-01-05T10:00:00Z"))).toBe(false); // 18:00
  });

  test("throws a clear missing-year calendar error instead of using a fallback", () => {
    expect(() => isDeepSeekPeakTime(at("2027-01-04T01:00:00Z")))
      .toThrow(MissingHolidayCalendarError);
    expect(() => isDeepSeekPeakTime(at("2027-01-04T01:00:00Z")))
      .toThrow("No China holiday calendar is available for 2027");
  });

  test("prices flash and V4 Pro directly in CNY per million tokens", () => {
    const flashPeak = deepseekMessage("flash-peak");
    expect(estimateDeepSeekMessageCostCny(flashPeak)).toBeCloseTo(3.204);

    const flashOffPeak = deepseekMessage("flash-off", "deepseek-flash", at("2026-01-05T04:00:00Z"));
    expect(estimateDeepSeekMessageCostCny(flashOffPeak)).toBeCloseTo(1.602);

    const proPeak = deepseekMessage("pro-peak", "deepseek-v4-pro");
    expect(estimateDeepSeekMessageCostCny(proPeak)).toBeCloseTo(13.08);

    const proOffPeak = deepseekMessage("pro-off", "deepseek-v4-pro", at("2026-01-05T04:00:00Z"));
    expect(estimateDeepSeekMessageCostCny(proOffPeak)).toBeCloseTo(6.54);
    expect(estimateDeepSeekMessageCostCny(deepseekMessage("alias", "some/deepseek_v4_pro")))
      .toBeCloseTo(13.08);
    expect(() => estimateDeepSeekMessageCostCny(deepseekMessage("unrelated", "not-deepseek-v4-proxy")))
      .toThrow("no schedule price");
  });

  test.each([
    ["DeepSeek root with necoapi child", "root-ds"],
    ["necoapi root with DeepSeek child", "child-ds"],
  ])("does not double count aggregate costs for %s", (_label, deepseekSessionID) => {
    const ds = deepseekMessage("ds-message");
    const neco = assistant("neco-message");
    neco.model = { providerID: "necoapi", id: "metered-model" };
    neco.cost = 0.5;
    const sessions = deepseekSessionID === "root-ds"
      ? [{ id: "root-ds", cost: 50 }, { id: "child-ds", cost: 0.5 }]
      : [{ id: "root-ds", cost: 0.5 }, { id: "child-ds", cost: 60 }];
    const groups = [
      { sessionID: "root-ds", messages: deepseekSessionID === "root-ds" ? [ds] : [neco] },
      { sessionID: "child-ds", messages: deepseekSessionID === "child-ds" ? [ds] : [neco] },
    ];
    const breakdown = computeCostBreakdown(
      sessions,
      groups.flatMap((group) => group.messages),
      [],
      scheduleOptions,
      groups,
    );

    expect(breakdown).toMatchObject({
      reportedCost: 0.5,
      cost: 0.5,
      weightedUsd: 0.5,
      directCny: 3.204,
      cny: 6.804,
      hasUsdCost: true,
    });
    expect(breakdown.reportedByProvider).toEqual({ necoapi: 0.5 });
  });

  test("reports missing timestamps or unknown schedule prices without guessing", () => {
    const noTime = deepseekMessage("missing-time");
    Object.defineProperty(noTime, "time", { value: {}, configurable: true });
    const noModelPrice = deepseekMessage("missing-model", "deepseek-unknown");
    const breakdown = computeCostBreakdown(
      [{ id: "root", cost: 100 }],
      [noTime, noModelPrice],
      [],
      scheduleOptions,
      [{ sessionID: "root", messages: [noTime, noModelPrice] }],
    );

    expect(breakdown).toMatchObject({
      reportedCost: 0,
      cost: 0,
      weightedUsd: 0,
      directCny: 0,
    });
    expect(breakdown.costError).toContain("requires message.time.created or message.time.completed");
    expect(breakdown.costError).toContain("no schedule price for model \"deepseek-unknown\"");
  });

  test("does not apply a top-level DeepSeek schedule to unrelated providers", () => {
    const message = assistant("not-deepseek");
    message.model = { providerID: "necoapi", id: "deepseek-flash" };
    message.cost = 0.5;
    const breakdown = computeCostBreakdown(
      [{ id: "root", cost: 0.5 }],
      [message],
      [],
      { pricingMode: "deepseek-schedule" },
      [{ sessionID: "root", messages: [message] }],
    );
    expect(breakdown).toMatchObject({ reportedCost: 0.5, directCny: 0, weightedUsd: 0.5 });
    expect(breakdown.costError).toBeUndefined();
  });

  test("requires native CNY currency for DeepSeek schedule mode", () => {
    const message = deepseekMessage("currency-required");
    const breakdown = computeCostBreakdown(
      [{ id: "root", cost: 0.5 }],
      [message],
      [],
      { providers: { deepseek: { currency: "USD", pricingMode: "deepseek-schedule" } } },
      [{ sessionID: "root", messages: [message] }],
    );

    expect(breakdown.directCny).toBe(0);
    expect(breakdown.reportedCost).toBe(0.5);
    expect(breakdown.costError).toBeUndefined();
  });

  test("guards standard costs when DeepSeek and another provider share one session", () => {
    const ds = deepseekMessage("shared-ds");
    const standard = assistant("shared-standard");
    standard.model = { providerID: "necoapi", id: "metered-model" };
    standard.cost = 3;
    const breakdown = computeCostBreakdown(
      [{ id: "root", cost: 2 }],
      [ds, standard],
      [],
      scheduleOptions,
      [{ sessionID: "root", messages: [ds, standard] }],
    );

    expect(breakdown.directCny).toBeCloseTo(3.204);
    expect(breakdown.reportedByProvider).toEqual({});
    expect(breakdown.weightedUsd).toBe(0);
    expect(breakdown.cny).toBeCloseTo(3.204);
    expect(breakdown.costError).toContain("exceed the mixed session aggregate");
  });

  test("uses completed only when created is absent and reports unavailable timestamps", () => {
    const message = deepseekMessage("completed-fallback");
    Object.defineProperty(message, "time", {
      value: { completed: at("2026-01-05T01:00:00Z") },
      configurable: true,
    });
    expect(estimateDeepSeekMessageCostCny(message)).toBeCloseTo(3.204);
    Object.defineProperty(message, "time", { value: {}, configurable: true });
    expect(() => estimateDeepSeekMessageCostCny(message))
      .toThrow("requires message.time.created or message.time.completed");
  });
});

describe("descendant fetching", () => {
  test("follows message cursors and requests only assistant messages", async () => {
    const client = clientFor({}, {});
    const calls: unknown[] = [];
    client.message.list = async (input) => {
      calls.push(input);
      return input.cursor
        ? { data: [assistant("second")], cursor: {} }
        : { data: [assistant("first")], cursor: { next: "more" } };
    };
    expect(await fetchSessionMessages(client, "root")).toHaveLength(2);
    expect(calls).toEqual([
      { sessionID: "root", type: "assistant", limit: 100, order: "desc" },
      { sessionID: "root", type: "assistant", limit: 100, cursor: "more" },
    ]);
  });

  test("follows child cursors without including unrelated sessions", async () => {
    const client = clientFor({}, {});
    client.session.list = async (input) => {
      if (input?.parentID !== "root") return { data: [], cursor: {} };
      return input.cursor
        ? { data: [session("second")], cursor: {} }
        : { data: [session("first")], cursor: { next: "more" } };
    };
    expect((await fetchDescendants(client, "root")).sessions.map((s) => s.id))
      .toEqual(["first", "second"]);
  });

  test("includes compactions only when requested and follows their message cursors", async () => {
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 1 },
    };
    const client = clientFor({}, {});
    const calls: unknown[] = [];
    client.message.list = async (input) => {
      calls.push(input);
      return input.cursor
        ? { data: [assistant("first")], cursor: {} }
        : { data: [reset], cursor: { next: "more" } };
    };
    expect(await fetchSessionMessages(client, "root", true)).toEqual([reset, assistant("first")]);
    expect(calls).toEqual([
      { sessionID: "root", limit: 100, order: "desc" },
      { sessionID: "root", limit: 100, cursor: "more" },
    ]);
  });

  test("detects descendant misses separately and excludes compactions from turn counts", async () => {
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 0 },
    };
    const client = clientFor({ root: [session("a"), session("b")] }, {
      a: [cacheRequest("a-first", 1, { read: 100_000 })],
      b: [reset, cacheRequest("b-first", 2, { write: 100_000 }), cacheRequest("b-miss", 3, { write: 110_000 })],
    });
    const data = await fetchDescendants(client, "root", true);
    expect(data.turns).toBe(3);
    expect(data.messages.every((message) => message.type === "assistant")).toBe(true);
    expect(data.cacheMisses).toEqual([{
      sessionID: "b", messageID: "b-miss", missedTokens: 100_000, modelChanged: false, idleMs: 1,
    }]);
  });

  test("collects nested descendants once and counts their assistant turns", async () => {
    const child = session("child");
    const grandchild = session("grandchild");
    const client = clientFor(
      { root: [child], child: [grandchild], grandchild: [child] },
      { child: [assistant("child-1")], grandchild: [assistant("grandchild-1")] },
    );

    await expect(fetchDescendants(client, "root")).resolves.toEqual({
      sessions: [child, grandchild],
      messages: [assistant("child-1"), assistant("grandchild-1")],
      messageGroups: [
        { sessionID: "child", messages: [assistant("child-1")] },
        { sessionID: "grandchild", messages: [assistant("grandchild-1")] },
      ],
      turns: 2,
      cacheMisses: [],
    });
  });

  test("fails the refresh when any descendant request fails", async () => {
    const client = clientFor({ root: [session("child")] }, {});
    const messageApi = client.message as unknown as {
      list: () => Promise<never>;
    };
    messageApi.list = async () => {
      throw new Error("unavailable");
    };

    await expect(fetchDescendants(client, "root")).rejects.toThrow("unavailable");
  });

  test("limits concurrent descendant requests", async () => {
    let active = 0;
    let peak = 0;
    const children: Record<string, Session[]> = {
      root: Array.from({ length: 8 }, (_, index) => session(`child-${index}`)),
    };
    const client = clientFor(children, {});
    const sessionApi = client.session as unknown as {
      list: ({ parentID }: { parentID: string }) => Promise<{ data: Session[]; cursor: object }>;
    };
    sessionApi.list = async ({ parentID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return { data: children[parentID] ?? [], cursor: {} };
    };

    await fetchDescendants(client, "root");
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("Pi-style cache-miss detection", () => {
  test("ignores the first request and healthy cache reads, and detects full and partial misses", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const healthy = cacheRequest("healthy", 60_000, { read: 100_000, write: 5_000 });
    expect(detectCacheMisses([healthy, first], "root")).toEqual([]);
    const miss = cacheRequest("miss", 600_000, { write: 110_000 });
    expect(detectCacheMisses([miss, healthy, first], "root")).toEqual([{
      sessionID: "root", messageID: "miss", missedTokens: 105_000, modelChanged: false, idleMs: 540_000,
    }]);
    const partial = cacheRequest("partial", 120_000, { read: 80_000, write: 30_000 });
    expect(detectCacheMisses([first, healthy, partial], "root")[0].missedTokens).toBe(25_000);
  });

  test("ignores 1024-token noise, prompt growth, and a fully cached smaller prompt", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const noise = cacheRequest("noise", 1, { read: 98_976, write: 1024 });
    expect(detectCacheMisses([first, noise], "root")).toEqual([]);
    noise.tokens!.cache.read -= 1;
    noise.tokens!.cache.write += 1;
    expect(detectCacheMisses([first, noise], "root")[0].missedTokens).toBe(1025);
    const smaller = cacheRequest("smaller", 1, { read: 20_000 });
    const larger = cacheRequest("larger", 2, { read: 20_000, write: 100_000 });
    expect(detectCacheMisses([first, smaller, larger], "root")).toEqual([]);
  });

  test("requires cache activity but remembers it for read-only providers and zero-usage messages", () => {
    const first = cacheRequest("first", 0, { input: 100_000 });
    const next = cacheRequest("next", 1, { input: 110_000 });
    expect(detectCacheMisses([first, next], "root")).toEqual([]);
    first.tokens!.cache.read = 100_000;
    first.tokens!.input = 0;
    const zero = cacheRequest("zero", 0.5, {});
    expect(detectCacheMisses([first, zero, next], "root")[0].missedTokens).toBe(100_000);
  });

  test("resets after compaction and does not exempt model switches", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const next = cacheRequest("next", 2, { write: 100_000 });
    next.model = { providerID: "other-provider", id: "other-model" };
    expect(detectCacheMisses([first, next], "root")[0].modelChanged).toBe(true);
    const reset: SessionMessageInfo = {
      id: "reset", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 1 },
    };
    expect(detectCacheMisses([first, reset, next], "root")).toEqual([]);
  });

  test("ignores failed, incomplete, and tokenless responses without replacing the baseline", () => {
    const first = cacheRequest("first", 0, { write: 100_000 });
    const failed = cacheRequest("failed", 1, { write: 200_000 });
    failed.error = { type: "provider.unknown", message: "unavailable" };
    const streaming = cacheRequest("streaming", 2, { write: 200_000 });
    delete streaming.time.completed;
    const tokenless = cacheRequest("tokenless", 3, {});
    delete tokenless.tokens;
    const healthy = cacheRequest("healthy", 4, { read: 100_000 });
    expect(detectCacheMisses([first, failed, streaming, tokenless, healthy], "root")).toEqual([]);
  });
});

test("V2 plugin renders, switches sessions, retains totals on failure, and cleans up", async () => {
  expect(plugin.id).toBe("opencode-session-tokens-sidebar");
  expect(typeof plugin.setup).toBe("function");
  const client = clientFor({ root: [session("child")] }, {
    root: [assistant("root-turn")], child: [assistant("child-turn")],
    other: [assistant("other-turn")],
  });
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
  const color = RGBA.fromHex("#c6d0f5");
  const muted = RGBA.fromHex("#949cbb");
  const accent = RGBA.fromHex("#8caaee");
  const border = RGBA.fromHex("#51576d");
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let select: (id: string) => void;
  let slotRemoved = false;
  const context = {
    client,
    options: {
      usdMultiplier: 1.5,
      rechargeCnyPerUsd: 7.2,
      providers: { provider: { usdMultiplier: 1, rechargeCnyPerUsd: 8 } },
    },
    storage: storageFor({}),
    keymap: { layer() {} },
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) {
        claim = value;
        return () => { slotRemoved = true; };
      },
    },
    theme: {
      text: {
        base: color, muted,
        feedback: { info: { base: accent }, warning: { base: color }, error: { base: color } },
      },
      border: { base: border },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    const [selected, setSelected] = createSignal("root");
    select = setSelected;
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ get sessionID() { return selected(); } });
  }, { width: 60, height: 20 });
  try {
    await view.waitForFrame((frame) => frame.includes("2 turns"));
    expect(view.captureCharFrame()).toContain("Session Token Summary");
    expect(view.captureCharFrame()).toContain("$2.50");
    expect(view.captureCharFrame()).toContain("¥18.80");
    const spans = view.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text.includes("Session Token Summary"))?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("2 turns"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.includes("↑ input"))?.fg.equals(muted)).toBe(true);
    expect(spans.find((span) => span.text.trim() === "100")?.fg.equals(color)).toBe(true);
    expect(spans.find((span) => span.text.includes("─"))?.fg.equals(border)).toBe(true);
    const total = spans.find((span) => span.text.trim() === "132");
    expect(total?.fg.equals(color)).toBe(true);
    expect((total?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(spans.find((span) => span.text.includes("$2.50"))?.fg.equals(color)).toBe(true);

    const quota = assistant("quota");
    quota.cost = 0;
    client.message.list = async ({ sessionID }) => ({
      data: sessionID === "root" ? [quota] : [assistant("other-turn")], cursor: {},
    });
    const pricing = Promise.withResolvers<{ data: Model[]; location: { directory: string } }>();
    let pricingStarted = false;
    client.model = {
      list: async () => { pricingStarted = true; return pricing.promise; },
    } as OpenCodeClient["model"];
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    expect(pricingStarted).toBe(true);
    select!("other");
    await view.waitForFrame((frame) => frame.includes("1 turn"));
    expect(view.captureCharFrame()).toContain("$1.25");
    expect(view.captureCharFrame()).toContain("¥9.40");
    pricing.resolve({ data: [], location: { directory: "/" } });
    await view.flush();
    expect(view.captureCharFrame()).toContain("1 turn");
    expect(view.captureCharFrame()).not.toContain("2 turns");

    client.session.get = async () => { throw new Error("unavailable"); };
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    await Bun.sleep(250);
    await view.flush();
    expect(view.captureCharFrame()).toContain("$1.25");
    expect(view.captureCharFrame()).not.toContain("unavailable");
    handlers.get("session.usage.updated")!({ data: { sessionID: "other" } });
    cleanup!();
    expect(handlers.size).toBe(0);
    expect(slotRemoved).toBe(true);
  } finally {
    if (!slotRemoved) cleanup?.();
    await view.dispose();
  }
});

test("DeepSeek cost errors render in red without hiding token rows", async () => {
  const message = assistant("deepseek-no-time");
  message.model = { providerID: "deepseek", id: "deepseek-flash" };
  message.cost = 0.25;
  Object.defineProperty(message, "time", { value: {}, configurable: true });
  const client = clientFor({}, { root: [message] });
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  const base = RGBA.fromHex("#c6d0f5");
  const error = RGBA.fromHex("#ed8796");
  const context = {
    client,
    options: { providers: { deepseek: { currency: "CNY", pricingMode: "deepseek-schedule" } } },
    storage: storageFor({}),
    keymap: { layer() {} },
    data: { on: () => () => {} },
    ui: { slot: (value: SlotClaim<"sidebar.content">) => { claim = value; return () => {}; } },
    theme: {
      text: {
        base,
        muted: base,
        feedback: { info: { base }, warning: { base }, error: { base: error } },
      },
      border: { base },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ sessionID: "root" });
  }, { width: 90, height: 16 });
  try {
    await view.waitForFrame((frame) => frame.includes("Cost error:"));
    const frame = view.captureCharFrame();
    expect(frame).toContain("↑ input");
    expect(frame).toContain("50");
    expect(frame).toContain("requires message.time.created or message.time.");
    expect(frame).toContain("completed for model \"deepseek-flash\"");
    const errorSpan = view.captureSpans().lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Cost error:"));
    expect(errorSpan?.fg.equals(error)).toBe(true);
  } finally {
    cleanup?.();
    await view.dispose();
  }
});

test("sidebar settings support mouse, keyboard, version display, persistence, and save errors", async () => {
  const saved: Record<string, object> = {};
  const storage = storageFor(saved);
  let failSave = false;
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let command: KeymapCommand;
  let saveError = "";
  const client = clientFor({}, { root: [assistant("turn")] });
  const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>();
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
  const color = RGBA.fromHex("#c6d0f5");
  const context = {
    client,
    options: { usdMultiplier: 1, rechargeCnyPerUsd: 7.2 },
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    storage: {
      store<Value extends object>(key: string, options: { initial: Value }) {
        const [state, update] = storage.store(key, options);
        return [state, async (mutation: (draft: Value) => void) => {
          if (failSave) throw new Error("disk full");
          await update(mutation);
        }] as const;
      },
    },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: (value: SlotClaim<"sidebar.content">) => { claim = value; return () => {}; },
      dialog: {
        show: (render: () => JSX.Element) => { setDialog(() => render); },
        set: () => {},
        clear: () => { setDialog(undefined); },
      },
      toast: { show: ({ message }: { message: string }) => { saveError = message; } },
    },
    theme: {
      text: {
        base: color, muted: color,
        feedback: { info: { base: color }, warning: { base: color }, error: { base: color } },
      },
      border: { base: color },
    },
  } as unknown as Context;
  const render = () => {
    cleanup = plugin.setup(context) as () => void;
    return [claim.render({ sessionID: "root" }), createComponent(() => Show({
      get when() { return dialog(); },
      keyed: true,
      children: (render: () => JSX.Element) => render(),
    }), {})];
  };
  const view = await testRender(render, { width: 60, height: 40 });
  const clickText = async (text: string, button: 0 | 2 = 0, target = view) => {
    const lines = target.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    expect(y).toBeGreaterThanOrEqual(0);
    await target.mockMouse.click(lines[y].indexOf(text), y, button);
    await target.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("↑ input"));
    expect(view.captureCharFrame()).toContain("¥7.20");
    await clickText("Session Token Summary", 2);
    expect(dialog()).toBeUndefined();
    await clickText("Session Token Summary");
    await view.waitForFrame((frame) => frame.includes(`Session Token Summary · v${version}`));
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("Options");
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    await clickText("[ ] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    await clickText("[x] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("[ ] Thinking tokens");
    expect(view.captureCharFrame()).not.toContain("✦ think");
    await clickText("[ ] Thinking tokens");
    expect(view.captureCharFrame()).toContain("✦ think");
    await clickText("[x] Thinking tokens");
    expect(view.captureCharFrame()).not.toContain("✦ think");
    await clickText("[ ] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("5.6%");
    expect(view.captureCharFrame()).toContain("ø cache hit");
    expect(view.captureCharFrame().toLowerCase()).not.toContain("cache hit ratio");
    await clickText("[x] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("0.1×");
    await clickText("[ ] Cache hit as percentage");
    await clickText("[ ] Hide empty rows");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    await clickText("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[ ] Input tokens");
    expect(view.captureCharFrame()).not.toContain("↑ input");
    expect(view.captureCharFrame()).toContain("Σ total");

    view.mockInput.pressArrow("down");
    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[ ] Output tokens");
    expect(view.captureCharFrame()).not.toContain("↓ output");
    await clickText("[x] Total tokens");
    expect(view.captureCharFrame()).not.toContain("Σ total");
    expect(view.captureCharFrame()).toContain("$1.00");

    failSave = true;
    await clickText("[x] Cost");
    expect(saveError).toBe("Could not save sidebar preferences");
    expect(view.captureCharFrame()).toContain("[x] Cost");
    failSave = false;
    await clickText("Close");
    expect(dialog()).toBeUndefined();
    expect(command!.palette).toBe(true);
    command!.run();
    await view.waitForFrame((frame) => frame.includes(`v${version}`));
    view.mockInput.pressEscape();
    // A bare Escape waits for the terminal's ambiguous-sequence timeout.
    await Bun.sleep(30);
    await view.flush();
    expect(dialog()).toBeUndefined();
    expect(saved.settings).toEqual({
      hidden: ["reasoning", "input", "output", "total"],
      hideEmpty: true,
      cachePercentage: true,
      cacheMissNotices: false,
    });
  } finally {
    cleanup?.();
    await view.dispose();
  }

  const restarted = await testRender(render, { width: 60, height: 40 });
  try {
    await restarted.waitForFrame((frame) => frame.includes("$1.00"));
    expect(restarted.captureCharFrame()).toContain("5.6%");
    expect(restarted.captureCharFrame()).not.toContain("↑ input");
    expect(restarted.captureCharFrame()).not.toContain("↓ output");
    expect(restarted.captureCharFrame()).not.toContain("Σ total");
    command!.run();
    await restarted.waitForFrame((frame) => frame.includes("[ ] Input tokens"));
    expect(restarted.captureCharFrame()).toContain("[x] Hide empty rows");
    expect(restarted.captureCharFrame()).toContain("[x] Cache hit as percentage");
    restarted.mockInput.pressEnter();
    await restarted.flush();
    expect(restarted.captureCharFrame()).toContain("↑ input");
    expect(restarted.captureCharFrame()).toContain("[x] Input tokens");
    for (const [option, sidebarText] of [
      ["Input tokens", "↑ input"],
      ["Cache write", "▤ cache write"],
      ["Cache read", "▤ cache read"],
      ["Cache hit", "ø cache hit"],
      ["Cost", "$1.00"],
      ["Turn count", "1 turn"],
    ]) {
      const lines = restarted.captureCharFrame().split("\n");
      const text = `[x] ${option}`;
      const y = lines.findIndex((line) => line.includes(text));
      expect(y).toBeGreaterThanOrEqual(0);
      await restarted.mockMouse.click(lines[y].indexOf(text), y);
      await restarted.flush();
      expect(restarted.captureCharFrame()).not.toContain(sidebarText);
      if (option === "Cost") {
        expect(restarted.captureCharFrame()).not.toContain("实际消耗 CNY");
        expect(restarted.captureCharFrame()).not.toContain("¥7.20");
      }
    }
    expect(restarted.captureCharFrame()).not.toContain("实际消耗 CNY");
    expect(restarted.captureCharFrame()).not.toContain("¥7.20");
    expect(restarted.captureCharFrame()).toContain("Session Token Summary");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressKey(" ");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressKey(" ");
    restarted.mockInput.pressTab();
    restarted.mockInput.pressTab();
    restarted.mockInput.pressEnter();
    await restarted.flush();
    expect(dialog()).toBeUndefined();
  } finally {
    cleanup?.();
    await restarted.dispose();
  }

  // Old saved settings omit the new options and retain their metric choices.
  saved.settings = { hidden: [] };
  const empty = session("root");
  empty.cost = 0;
  empty.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  client.session.get = async () => empty;
  client.message.list = async () => ({ data: [], cursor: {} });
  const legacy = await testRender(render, { width: 60, height: 40 });
  try {
    await legacy.waitForFrame((frame) => frame.includes("$0.00"));
    expect(legacy.captureCharFrame()).toContain("✦ think");
    expect(legacy.captureCharFrame()).toContain("0 turns");
    command!.run();
    await legacy.waitForFrame((frame) => frame.includes("[ ] Hide empty rows"));
    expect(legacy.captureCharFrame()).toContain("[x] Thinking tokens");
    await clickText("[ ] Hide empty rows", 0, legacy);
    for (const label of [
      "↑ input", "↓ output", "▤ cache write", "▤ cache read", "ø cache hit", "✦ think",
      "Σ total", "$0.00", "实际消耗 CNY", "¥0.00", "0 turns",
    ]) {
      expect(legacy.captureCharFrame()).not.toContain(label);
    }
    expect(legacy.captureCharFrame().split("Session Token Summary")).toHaveLength(3);
    await clickText("[x] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("$0.00");
    await clickText("[ ] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("—");
    expect(legacy.captureCharFrame()).not.toContain("NaN");

    empty.tokens.cache.read = 10;
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await legacy.waitForFrame((frame) => frame.includes("100.0%"));
    await clickText("[x] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("∞");
    await clickText("[ ] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("ø cache hit");
    expect(legacy.captureCharFrame()).toContain("Σ total");
    expect(legacy.captureCharFrame()).not.toContain("▤ cache write");
    expect(legacy.captureCharFrame()).not.toContain("$0.00");

    empty.tokens.cache.read = 0;
    empty.tokens.input = 10;
    empty.cost = 0.001;
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await legacy.waitForFrame((frame) => frame.includes("<$0.01"));
    expect(legacy.captureCharFrame()).toContain("↑ input");
    expect(legacy.captureCharFrame()).not.toContain("ø cache hit");
    await clickText("[x] Hide empty rows", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("0.0×");
    await clickText("[ ] Cache hit as percentage", 0, legacy);
    expect(legacy.captureCharFrame()).toContain("0.0%");
  } finally {
    cleanup?.();
    await legacy.dispose();
  }
});

test("cache-miss notices report new significant misses once, per session, without replaying history", async () => {
  const histories: Record<string, SessionMessageInfo[]> = {
    root: [cacheRequest("first", 0, { write: 100_000 }), cacheRequest("historical-miss", 60_000, { write: 105_000 })],
    child: [cacheRequest("child-first", 0, { write: 100_000 })],
    other: [cacheRequest("other-first", 0, { write: 100_000 }), cacheRequest("other-miss", 60_000, { write: 100_000 })],
  };
  const saved = { settings: { hidden: ["reasoning"], hideEmpty: false, cachePercentage: false, cacheMissNotices: true } };
  const storage = storageFor(saved);
  const notices: ToastOptions[] = [];
  const children: Record<string, Session[]> = { root: [session("child")] };
  const client = clientFor(children, histories);
  const handlers = new Map<string, (event: { data: { sessionID: string; parentID?: string } }) => void>();
  let claim: SlotClaim<"sidebar.content">;
  let cleanup: (() => void) | undefined;
  let changeNotices: (enabled: boolean) => Promise<void>;
  let select: (sessionID: string) => void;
  const color = RGBA.fromHex("#c6d0f5");
  const context = {
    client,
    storage: {
      store<Value extends object>(key: string, options: { initial: Value }) {
        const [state, update] = storage.store(key, options);
        changeNotices = (enabled) => update((draft) => { Object.assign(draft, { cacheMissNotices: enabled }); });
        return [state, update] as const;
      },
    },
    keymap: { layer() {} },
    data: {
      on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
        handlers.set(type, handler);
        return () => { handlers.delete(type); };
      },
    },
    ui: {
      slot(value: SlotClaim<"sidebar.content">) { claim = value; return () => {}; },
      toast: { show: (options: ToastOptions) => { notices.push(options); } },
    },
    theme: {
      text: { base: color, muted: color, feedback: { info: { base: color }, warning: { base: color }, error: { base: color } } },
      border: { base: color },
    },
  } as unknown as Context;
  const view = await testRender(() => {
    const [selected, setSelected] = createSignal("root");
    select = setSelected;
    cleanup = plugin.setup(context) as () => void;
    return claim.render({ get sessionID() { return selected(); } });
  }, { width: 60, height: 20 });
  const refresh = async (sessionID = "root") => {
    handlers.get("session.step.ended")!({ data: { sessionID } });
    await Bun.sleep(250);
    await view.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("3 turns"));
    expect(notices).toEqual([]);
    histories.root.push(cacheRequest("partial-miss", 600_000, { read: 80_000, write: 30_000 }));
    await refresh();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      title: "Possible cache miss after 9m idle",
      message: "25K previously processed tokens weren’t read from cache.",
      variant: "warning", sessionID: "root",
    });
    await refresh();
    expect(notices).toHaveLength(1);

    const childMiss = cacheRequest("child-miss", 1_000, { write: 110_000 });
    childMiss.model = { providerID: "provider", id: "other-model" };
    histories.child.push(childMiss);
    await refresh("child");
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ title: "Possible cache miss after model switch", sessionID: "child" });
    histories.root.push(cacheRequest("noise", 610_000, { read: 108_500, write: 1_500 }));
    await refresh();
    expect(notices).toHaveLength(2);

    await changeNotices!(false);
    histories.root.push(cacheRequest("disabled-miss", 620_000, { write: 130_000 }));
    handlers.get("session.usage.updated")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(2);
    await changeNotices!(true);
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(2);
    histories.root.push(cacheRequest("enabled-miss", 630_000, { read: 30_000, write: 140_000 }));
    await refresh();
    expect(notices).toHaveLength(3);

    const listMessages = client.message.list;
    const delayed = Promise.withResolvers<{ data: SessionMessageInfo[]; cursor: {} }>();
    const oldSnapshot = [...histories.root];
    let waiting = false;
    client.message.list = async (input) => {
      if (input.sessionID !== "root") return listMessages(input);
      waiting = true;
      return delayed.promise;
    };
    handlers.get("session.step.ended")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    expect(waiting).toBe(true);
    await changeNotices!(false);
    await changeNotices!(true);
    histories.root.push(cacheRequest("toggle-miss", 640_000, { write: 180_000 }));
    client.message.list = listMessages;
    delayed.resolve({ data: oldSnapshot, cursor: {} });
    await Bun.sleep(250);
    await view.flush();
    expect(notices).toHaveLength(3);

    select!("other");
    await view.waitForFrame((frame) => frame.includes("2 turns"));
    expect(notices).toHaveLength(3);
    select!("root");
    await view.waitForFrame((frame) => frame.includes("9 turns"));
    expect(notices).toHaveLength(3);
    histories.root.push({
      id: "compaction", type: "compaction", status: "completed", reason: "manual",
      summary: "", recent: "", time: { created: 645_000 },
    }, cacheRequest("after-compaction", 650_000, { write: 100_000 }));
    await refresh();
    expect(notices).toHaveLength(3);
    expect(view.captureCharFrame()).toContain("10 turns");

    const discovery = Promise.withResolvers<{ data: SessionMessageInfo[]; cursor: {} }>();
    client.message.list = async (input) => input.sessionID === "root" ? discovery.promise : listMessages(input);
    handlers.get("session.step.ended")!({ data: { sessionID: "root" } });
    await Bun.sleep(250);
    children.root.push(session("fresh-child"));
    children["fresh-child"] = [session("nested-child")];
    for (const [sessionID, parentID] of [["fresh-child", "root"], ["nested-child", "fresh-child"]]) {
      handlers.get("session.created")!({ data: { sessionID, parentID } });
      histories[sessionID] = [
        cacheRequest(`${sessionID}-first`, 660_000, { write: 100_000 }),
        cacheRequest(`${sessionID}-miss`, 670_000, { write: 110_000 }),
      ];
    }
    client.message.list = listMessages;
    discovery.resolve({ data: [...histories.root], cursor: {} });
    await refresh("nested-child");
    expect(notices).toHaveLength(5);
    expect(notices.slice(3).map((notice) => notice.sessionID)).toEqual(["fresh-child", "nested-child"]);
    expect(notices[3].message).toBe("100K previously processed tokens weren’t read from cache.");
    handlers.get("session.created")!({ data: { sessionID: "fresh-child", parentID: "root" } });
    await refresh("fresh-child");
    expect(notices).toHaveLength(5);
  } finally {
    cleanup?.();
    expect(handlers.size).toBe(0);
    await view.dispose();
  }
});

test.each([18, 20])("settings popup stays readable and scrolls with mouse and keyboard at %i rows", async (height) => {
  const saved: Record<string, object> = {};
  const color = RGBA.fromHex("#c6d0f5");
  let renderDialog: () => JSX.Element;
  let command: KeymapCommand;
  let cleanup: (() => void) | undefined;
  let closed = false;
  const context = {
    storage: storageFor(saved),
    data: { on: () => () => {} },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: () => () => {},
      dialog: {
        show: (render: () => JSX.Element) => { renderDialog = render; },
        set: () => {},
        clear: () => { closed = true; },
      },
    },
    theme: { text: { base: color, muted: color }, border: { base: color } },
  } as unknown as Context;
  const view = await testRender(() => {
    cleanup = plugin.setup(context) as () => void;
    command.run();
    return renderDialog();
  }, { width: 60, height });
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain(`Session Token Summary · v${version}`);
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[x] Cache read");
    expect(view.captureCharFrame()).toContain("[x] Cache hit");
    if (height >= 20) expect(view.captureCharFrame()).toContain("[ ] Thinking tokens");
    expect(view.captureCharFrame()).toContain("Close");

    for (let i = 0; i < 11; i++) view.mockInput.pressArrow("down");
    await view.flush();
    expect(view.captureCharFrame()).toContain("Options");
    expect(view.captureCharFrame()).toContain("[ ] Hide empty rows");
    expect(view.captureCharFrame()).toContain("[ ] Cache hit as percentage");
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    expect(saved.settings).toMatchObject({ cacheMissNotices: true });

    view.resize(60, 12);
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    expect(view.captureCharFrame()).toContain("Close");
    for (let i = 0; i < 11; i++) view.mockInput.pressArrow("up");
    await view.flush();
    expect(view.captureCharFrame()).toContain("Show/hide");
    expect(view.captureCharFrame()).toContain("[x] Input tokens");

    view.resize(60, height);
    await view.flush();
    const inputY = view.captureCharFrame().split("\n").findIndex((line) => line.includes("[x] Input tokens"));
    for (let i = 0; i < 15; i++) await view.mockMouse.scroll(5, inputY, "down");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Show cache-miss notices");
    const lines = view.captureCharFrame().split("\n");
    const optionY = lines.findIndex((line) => line.includes("[x] Show cache-miss notices"));
    await view.mockMouse.click(lines[optionY].indexOf("[x]"), optionY);
    await view.flush();
    expect(view.captureCharFrame()).toContain("[ ] Show cache-miss notices");
    view.mockInput.pressTab();
    view.mockInput.pressEnter();
    await view.flush();
    expect(closed).toBe(true);
  } finally {
    cleanup?.();
    await view.dispose();
  }
});

test("compiled ./tui export stays reactive when loaded from a node_modules path", async () => {
  const { copyFileSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const pkgDir = resolve(import.meta.dir, "../node_modules/.opencode-plugin-session-token-summary-test");
  const distDir = resolve(pkgDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(resolve(pkgDir, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(resolve(import.meta.dir, "../dist/tui.js"), resolve(distDir, "tui.js"));

  const saved: Record<string, object> = {};
  const color = RGBA.fromHex("#c6d0f5");
  let renderDialog: () => JSX.Element;
  let command: KeymapCommand;
  let cleanup: (() => void) | undefined;
  const context = {
    storage: storageFor(saved),
    data: { on: () => () => {} },
    keymap: { layer: (factory: () => { commands: KeymapCommand[] }) => { command = factory().commands[0]; } },
    ui: {
      slot: () => () => {},
      dialog: {
        show: (render: () => JSX.Element) => { renderDialog = render; },
        set: () => {},
        clear: () => {},
      },
    },
    theme: { text: { base: color, muted: color }, border: { base: color } },
  } as unknown as Context;

  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    const { default: compiledPlugin } = await import(pathToFileURL(resolve(distDir, "tui.js")).href);
    view = await testRender(() => {
      cleanup = compiledPlugin.setup(context) as () => void;
      command.run();
      return renderDialog();
    }, { width: 60, height: 24 });
    await view.flush();

    const isBold = (label: string) => {
      const spans = view!.captureSpans().lines.flatMap((line) => line.spans);
      const span = spans.find((s) => s.text.includes(label));
      return ((span?.attributes ?? 0) & TextAttributes.BOLD) === TextAttributes.BOLD;
    };

    expect(isBold("Input tokens")).toBe(true);
    expect(isBold("Output tokens")).toBe(false);

    view.mockInput.pressArrow("down");
    await view.flush();
    expect(isBold("Input tokens")).toBe(false);
    expect(isBold("Output tokens")).toBe(true);

    view.mockInput.pressKey(" ");
    await view.flush();
    expect(view.captureCharFrame()).toContain("[x] Input tokens");
    expect(view.captureCharFrame()).toContain("[ ] Output tokens");
    expect(isBold("Output tokens")).toBe(true);
    expect(saved.settings).toMatchObject({ hidden: ["reasoning", "output"] });
  } finally {
    cleanup?.();
    await view?.dispose();
    rmSync(pkgDir, { recursive: true, force: true });
  }
});
