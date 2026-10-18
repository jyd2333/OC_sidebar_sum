import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  ModelInfo,
  OpenCodeClient,
  SessionInfo,
} from "@opencode/client";

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number;
};

export type DescendantData = {
  sessions: ReadonlyArray<SessionInfo>;
  messages: ReadonlyArray<SessionMessageAssistant>;
  messageGroups: ReadonlyArray<SessionMessageGroup>;
  turns: number;
  cacheMisses: ReadonlyArray<CacheMiss>;
};

export type SessionMessageGroup = {
  sessionID: string;
  messages: ReadonlyArray<SessionMessageAssistant>;
};

export type CacheMiss = {
  sessionID: string;
  messageID: string;
  missedTokens: number;
  modelChanged: boolean;
  idleMs: number;
};

export type CostMode = "reported" | "estimated" | "mixed";

export type CostMessage = Pick<
  SessionMessageAssistant,
  "model" | "tokens"
> & { cost?: number };

export type CostSession = Pick<SessionInfo, "cost"> & Partial<Pick<SessionInfo, "id">>;

export type CostOptionsSource = Readonly<Record<string, unknown>> | undefined;

export type ResolvedCostOptions = {
  usdMultiplier: number;
  rechargeCnyPerUsd: number;
};

export type ProviderCostBreakdown = {
  cost: number;
  mode: CostMode;
  reportedCost: number;
  estimatedCost: number;
  weightedUsd: number;
  cny: number;
  reportedByProvider: Readonly<Record<string, number>>;
  estimatedByProvider: Readonly<Record<string, number>>;
  unattributedReportedCost: number;
  unattributedEstimatedCost: number;
};

export const EMPTY: TokenTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  cost: 0,
};

const FETCH_CONCURRENCY = 4;
const DEFAULT_USD_MULTIPLIER = 1;
const DEFAULT_RECHARGE_CNY_PER_USD = 7.2;

function validCostOption(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionValue(
  options: CostOptionsSource,
  name: keyof ResolvedCostOptions,
  fallback: number,
): number {
  const value = options?.[name];
  return validCostOption(value) ? value : fallback;
}

export function resolveTopLevelCostOptions(options: CostOptionsSource): ResolvedCostOptions {
  return {
    usdMultiplier: optionValue(options, "usdMultiplier", DEFAULT_USD_MULTIPLIER),
    rechargeCnyPerUsd: optionValue(
      options,
      "rechargeCnyPerUsd",
      DEFAULT_RECHARGE_CNY_PER_USD,
    ),
  };
}

/**
 * Resolve one provider's display options. Provider IDs are intentionally not
 * normalized: OpenCode provider IDs are opaque and must match exactly.
 */
export function resolveProviderCostOptions(
  options: CostOptionsSource,
  providerID?: string,
): ResolvedCostOptions {
  const topLevel = resolveTopLevelCostOptions(options);
  if (!providerID) return topLevel;

  const providers = options?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    return topLevel;
  }
  if (!Object.prototype.hasOwnProperty.call(providers, providerID)) return topLevel;

  const provider = (providers as Record<string, unknown>)[providerID];
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
    return topLevel;
  }

  return {
    usdMultiplier: optionValue(
      provider as Readonly<Record<string, unknown>>,
      "usdMultiplier",
      topLevel.usdMultiplier,
    ),
    rechargeCnyPerUsd: optionValue(
      provider as Readonly<Record<string, unknown>>,
      "rechargeCnyPerUsd",
      topLevel.rechargeCnyPerUsd,
    ),
  };
}

function hasPrice(model: ModelInfo): boolean {
  return model.cost.some((cost) =>
    cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0
  );
}

function normalizedModelID(id: string): string {
  return (id.split("/").pop() || id).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pricingFor(
  models: ReadonlyArray<ModelInfo>,
  providerID: string,
  modelID: string,
): ModelInfo | undefined {
  const exact = models.find((model) =>
    model.providerID === providerID && (model.id === modelID || model.modelID === modelID)
  );
  if (exact && hasPrice(exact)) return exact;

  const normalized = normalizedModelID(modelID);
  return models.find(
    (model) =>
      hasPrice(model) &&
      (normalizedModelID(model.id) === normalized || normalizedModelID(model.modelID) === normalized),
  );
}

export function estimateCost(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageCost(message, models);
  }
  return total;
}

function estimateMessageCost(
  message: CostMessage,
  models: ReadonlyArray<ModelInfo>,
): number {
  const model = pricingFor(models, message.model.providerID, message.model.id);
  if (!model || !message.tokens) return 0;

  const tokens = message.tokens;
  const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  const cost =
    model.cost
      .filter(
        (entry) => entry.tier?.type === "context" && contextTokens > entry.tier.size,
      )
      .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
    model.cost.find((entry) => !entry.tier);
  if (!cost) return 0;

  return (
    tokens.input * cost.input +
    (tokens.output + tokens.reasoning) * cost.output +
    tokens.cache.read * cost.cache.read +
    tokens.cache.write * cost.cache.write
  ) / 1_000_000;
}

/** Estimate explicit zero-cost messages while retaining their source provider. */
export function estimateCostByProvider(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): Readonly<Record<string, number>> {
  return estimateBreakdownByProvider(messages, models).byProvider;
}

function estimateBreakdownByProvider(
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): { byProvider: Record<string, number>; unattributed: number } {
  const totals: Record<string, number> = {};
  let unattributed = 0;
  for (const message of messages) {
    if (message.cost !== 0) continue;
    const estimate = estimateMessageCost(message, models);
    if (!(estimate > 0) || !Number.isFinite(estimate)) continue;
    if (typeof message.model.providerID === "string" && message.model.providerID.length > 0) {
      addCost(totals, message.model.providerID, estimate);
    } else {
      unattributed += estimate;
    }
  }
  return { byProvider: totals, unattributed };
}

function sumCostMap(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function validSessionCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addCost(
  totals: Record<string, number>,
  providerID: string,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  const current = Object.prototype.hasOwnProperty.call(totals, providerID)
    ? totals[providerID]!
    : 0;
  Object.defineProperty(totals, providerID, {
    value: current + value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return value;
}

/**
 * Combine session aggregate costs with assistant messages without counting the
 * same request twice. Session costs are authoritative for the raw reported
 * total. Message costs are used only to attribute that total to providers when
 * they reconcile to it; estimates are added only for explicit zero-cost
 * messages.
 */
export function computeCostBreakdown(
  sessions: ReadonlyArray<CostSession>,
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
  options?: CostOptionsSource,
  messageGroups?: ReadonlyArray<SessionMessageGroup>,
): ProviderCostBreakdown {
  const reportedCost = sessions.reduce((total, session) => {
    const value = session.cost;
    return total + (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);

  const reportedByProvider: Record<string, number> = {};
  let unattributedReportedCost = 0;
  const estimatedByProvider: Record<string, number> = {};
  let unattributedEstimatedCost = 0;

  const groupsBySession = messageGroups
    ? new Map(messageGroups.map((group) => [group.sessionID, group.messages]))
    : undefined;
  const sessionsForBreakdown = groupsBySession
    ? sessions.map((session) => ({
        aggregateCost: validSessionCost(session.cost),
        messages: groupsBySession.get(session.id ?? "") ?? [],
      }))
    : [{ aggregateCost: reportedCost, messages }];

  for (const session of sessionsForBreakdown) {
    const messageReportedByProvider: Record<string, number> = {};
    let messageReportedCost = 0;
    for (const message of session.messages) {
      if (typeof message.cost !== "number" || !Number.isFinite(message.cost) || message.cost <= 0) continue;
      messageReportedCost += message.cost;
      if (typeof message.model.providerID === "string" && message.model.providerID.length > 0) {
        addCost(messageReportedByProvider, message.model.providerID, message.cost);
      }
    }

    // A message total greater than this session's aggregate is stale or
    // duplicated data. Keep this session's aggregate, but do not make a
    // misleading provider split. Other sessions remain independently usable.
    if (messageReportedCost > session.aggregateCost) {
      unattributedReportedCost += session.aggregateCost;
    } else {
      for (const [providerID, value] of Object.entries(messageReportedByProvider)) {
        addCost(reportedByProvider, providerID, value);
      }
      unattributedReportedCost += Math.max(0, session.aggregateCost - sumCostMap(messageReportedByProvider));
    }

    const estimated = estimateBreakdownByProvider(session.messages, models);
    for (const [providerID, value] of Object.entries(estimated.byProvider)) {
      addCost(estimatedByProvider, providerID, value);
    }
    unattributedEstimatedCost += estimated.unattributed;
  }

  const estimatedCost = sumCostMap(estimatedByProvider) + unattributedEstimatedCost;
  const cost = reportedCost + estimatedCost;
  const mode: CostMode =
    estimatedCost > 0
      ? reportedCost > 0
        ? "mixed"
        : "estimated"
      : "reported";

  const topLevel = resolveTopLevelCostOptions(options);
  const unattributedCost = unattributedReportedCost + unattributedEstimatedCost;
  let weightedUsd = unattributedCost * topLevel.usdMultiplier;
  let cny = weightedUsd * topLevel.rechargeCnyPerUsd;
  for (const [providerID, value] of Object.entries(reportedByProvider)) {
    const provider = resolveProviderCostOptions(options, providerID);
    const weighted = value * provider.usdMultiplier;
    weightedUsd += weighted;
    cny += weighted * provider.rechargeCnyPerUsd;
  }
  for (const [providerID, value] of Object.entries(estimatedByProvider)) {
    const provider = resolveProviderCostOptions(options, providerID);
    const weighted = value * provider.usdMultiplier;
    weightedUsd += weighted;
    cny += weighted * provider.rechargeCnyPerUsd;
  }

  return {
    cost,
    mode,
    reportedCost,
    estimatedCost,
    weightedUsd,
    cny,
    reportedByProvider,
    estimatedByProvider,
    unattributedReportedCost,
    unattributedEstimatedCost,
  };
}

export function combineCosts(
  reportedCost: number,
  messages: ReadonlyArray<CostMessage>,
  models: ReadonlyArray<ModelInfo>,
): { cost: number; mode: CostMode } {
  const estimatedCost = estimateCost(
    messages.filter((message) => message.cost === 0),
    models,
  );
  return {
    cost: reportedCost + estimatedCost,
    mode:
      estimatedCost > 0
        ? reportedCost > 0
          ? "mixed"
          : "estimated"
        : "reported",
  };
}

export function isAssistant(m: SessionMessageInfo): m is SessionMessageAssistant {
  return m.type === "assistant";
}

export function computeTotals(messages: ReadonlyArray<SessionMessageInfo>): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    t.input += m.tokens?.input ?? 0;
    t.output += m.tokens?.output ?? 0;
    t.reasoning += m.tokens?.reasoning ?? 0;
    t.cacheRead += m.tokens?.cache.read ?? 0;
    t.cacheWrite += m.tokens?.cache.write ?? 0;
    t.cost += m.cost ?? 0;
    t.turns += 1;
  }
  return t;
}

export function sumSessions(
  sessions: ReadonlyArray<SessionInfo>,
  turns: number,
): TokenTotals {
  const t: TokenTotals = { ...EMPTY };
  for (const s of sessions) {
    const tk = s.tokens;
    if (!tk) continue;
    t.input += tk.input;
    t.output += tk.output;
    t.reasoning += tk.reasoning;
    t.cacheRead += tk.cache.read;
    t.cacheWrite += tk.cache.write;
    t.cost += s.cost ?? 0;
  }
  t.turns = turns;
  return t;
}

export async function mapWithConcurrency<Input, Output>(
  items: ReadonlyArray<Input>,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let next = 0;
  const count = Math.min(FETCH_CONCURRENCY, items.length);

  await Promise.all(
    Array.from({ length: count }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

// Pi-style prompt-overlap heuristic: token counts cannot prove a cache failure.
export function detectCacheMisses(
  messages: ReadonlyArray<SessionMessageInfo>,
  sessionID: string,
): CacheMiss[] {
  const misses: CacheMiss[] = [];
  let previous: SessionMessageAssistant | undefined;
  let previousPrompt = 0;
  let reportedCache = false;
  for (const message of [...messages].sort((a, b) =>
    a.time.created - b.time.created || a.id.localeCompare(b.id)
  )) {
    if (message.type === "compaction" && message.status === "completed") {
      previous = undefined;
      reportedCache = false;
      continue;
    }
    if (!isAssistant(message) || !message.tokens || message.error || message.time.completed === undefined) continue;
    const tokens = message.tokens;
    const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
    if (prompt <= 0) continue;
    const hasCache = tokens.cache.read + tokens.cache.write > 0;
    const missedTokens = Math.min(previousPrompt, prompt) - tokens.cache.read;
    if (previous && (hasCache || reportedCache) && missedTokens > 1024) {
      misses.push({
        sessionID,
        messageID: message.id,
        missedTokens,
        modelChanged: message.model.providerID !== previous.model.providerID || message.model.id !== previous.model.id,
        idleMs: Math.max(0, message.time.created - previous.time.created),
      });
    }
    previous = message;
    previousPrompt = prompt;
    reportedCache ||= hasCache;
  }
  return misses;
}

export async function fetchSessionMessages(
  client: OpenCodeClient,
  sessionID: string,
  includeCompactions = false,
): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(!includeCompactions ? { type: "assistant" as const } : {}),
      limit: 100,
      ...(cursor ? { cursor } : { order: "desc" }),
    });
    messages.push(...page.data.filter((message) => isAssistant(message) || includeCompactions && message.type === "compaction"));
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return messages;
}

export async function fetchDescendants(
  client: OpenCodeClient,
  rootID: string,
  includeCompactions = false,
): Promise<DescendantData> {
  const out: SessionInfo[] = [];
  const visited = new Set([rootID]);
  let level = [rootID];

  while (level.length > 0) {
    const childLists = await mapWithConcurrency(level, async (sessionID) => {
      const children: SessionInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.session.list({
          parentID: sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" }),
        });
        children.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return children;
    });
    const nextLevel: string[] = [];

    for (const children of childLists) {
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        out.push(child);
        nextLevel.push(child.id);
      }
    }
    level = nextLevel;
  }

  const histories = await mapWithConcurrency(out, async (session) => {
    const messages = await fetchSessionMessages(client, session.id, includeCompactions);
    return {
      sessionID: session.id,
      messages: messages.filter(isAssistant),
      cacheMisses: includeCompactions ? detectCacheMisses(messages, session.id) : [],
    };
  });
  const messages = histories.flatMap((history) => history.messages);
  const turns = messages.length;

  return {
    sessions: out,
    messages,
    messageGroups: histories.map(({ sessionID, messages: sessionMessages }) => ({
      sessionID,
      messages: sessionMessages,
    })),
    turns,
    cacheMisses: histories.flatMap((history) => history.cacheMisses),
  };
}
