/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createEffect, createSignal, on } from "solid-js";
import { version } from "./package.json";
import { computeCostBreakdown, detectCacheMisses, fetchSessionMessages, fetchDescendants, isAssistant, resolveProviderCostOptions, sumSessions } from "./usage";

const id = "opencode-session-tokens-sidebar";
const REFRESH_DELAY_MS = 200;
const METRICS = [
  ["input", "Input tokens"],
  ["output", "Output tokens"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
  ["cacheRatio", "Cache hit"],
  ["reasoning", "Thinking tokens"],
  ["total", "Total tokens"],
  ["cost", "Cost"],
  ["turns", "Turn count"],
] as const;
type Metric = (typeof METRICS)[number][0];
const OPTIONS = [
  ["hideEmpty", "Hide empty rows"],
  ["cachePercentage", "Cache hit as percentage"],
  ["cacheMissNotices", "Show cache-miss notices"],
] as const;
const SETTINGS = [...METRICS, ...OPTIONS];
type Option = (typeof OPTIONS)[number][0];
interface Settings {
  hidden: Metric[];
  hideEmpty: boolean;
  cachePercentage: boolean;
  cacheMissNotices: boolean;
}

interface UsageState {
  status: "loading" | "ready" | "error";
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Unweighted USD total (reported plus estimates); used for visibility/mode. */
  cost: number;
  costMode: "reported" | "estimated" | "mixed";
  weightedUsd: number;
  cny: number;
  turns: number;
  error?: string;
}

export interface CostDisplayOptions {
  usdMultiplier: number;
  rechargeCnyPerUsd: number;
}

export function costColorForCny(
  cny: number,
  colors: { info: RGBA; warning: RGBA; error: RGBA },
): RGBA {
  if (cny < 5) return colors.info;
  if (cny < 20) return colors.warning;
  return colors.error;
}

const EMPTY: UsageState = {
  status: "loading",
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costMode: "reported",
  weightedUsd: 0,
  cny: 0,
  turns: 0,
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.trunc(n));
}

function fmtCost(c: number): string {
  if (c > 0 && c < 0.01) return "<$0.01";
  return "$" + c.toFixed(2);
}

function fmtCny(c: number): string {
  return "¥" + c.toFixed(2);
}

export function resolveCostOptions(
  options: Readonly<Record<string, unknown>> | undefined,
  providerID?: string,
): CostDisplayOptions {
  return resolveProviderCostOptions(options, providerID);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to load session usage";
}

export default Plugin.define({
  id,
  setup(context) {
    const costOptions = context.options;
    let disposed = false;
    let loadID = 0;
    let lastSessionID = "";
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let knownSessionIDs = new Set<string>();
    const seenMisses = new Map<string, Set<string>>();
    const [state, setState] = createSignal<UsageState>({ ...EMPTY });
    const [settings, updateSettings] = context.storage.store<Settings>("settings", {
      initial: { hidden: ["reasoning"], hideEmpty: false, cachePercentage: false, cacheMissNotices: false },
    });
    const visible = (metric: Metric, value?: number) =>
      !settings.hidden.includes(metric) && (!settings.hideEmpty || value !== 0);
    const toggleSetting = (key: Metric | Option) => {
      void updateSettings((draft) => {
        if (key === "hideEmpty" || key === "cachePercentage" || key === "cacheMissNotices") {
          draft[key] = !draft[key];
        } else {
          draft.hidden = draft.hidden.includes(key)
            ? draft.hidden.filter((metric) => metric !== key)
            : [...draft.hidden, key];
        }
      }).catch(() => {
        context.ui.toast.show({ message: "Could not save sidebar preferences", variant: "error" });
      });
    };
    const openSettings = () => {
      context.ui.dialog.show(() => {
        const [selected, setSelected] = createSignal(0);
        const dimensions = useTerminalDimensions();
        let scroll: ScrollBoxRenderable | undefined;
        const scrollSelectedIntoView = () => {
          if (!scroll || scroll.isDestroyed) return;
          const setting = SETTINGS[selected()];
          if (selected() === 0) scroll.scrollTo(0);
          else if (setting) scroll.scrollChildIntoView(`${id}.setting.${setting[0]}`);
        };
        return (
          <box
            gap={1} padding={1} maxHeight="100%" focusable focused
            onKeyDown={(event) => {
              if (event.name === "down" || (event.name === "tab" && !event.shift)) {
                setSelected((index) => (index + 1) % (SETTINGS.length + 1));
              } else if (event.name === "up" || (event.name === "tab" && event.shift)) {
                setSelected((index) => (index + SETTINGS.length) % (SETTINGS.length + 1));
              } else if (event.name === "return" || event.name === "space") {
                const setting = SETTINGS[selected()];
                if (setting) toggleSetting(setting[0]);
                else context.ui.dialog.clear();
              } else if (event.name === "escape") {
                context.ui.dialog.clear();
              } else return;
              scrollSelectedIntoView();
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <text flexShrink={0} fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
              {`Session Token Summary · v${version}`}
            </text>
            <scrollbox
              ref={(value) => { scroll = value; }}
              // Leave space for the dialog chrome, title, and footer.
              height={Math.min(SETTINGS.length + 3, Math.max(2, dimensions().height - 12))}
              flexShrink={0} focusable={false}
              contentOptions={{ gap: 1 }}
              onSizeChange={() => queueMicrotask(scrollSelectedIntoView)}
            >
              <box flexShrink={0}>
                <text fg={context.theme.text.muted} attributes={TextAttributes.BOLD}>Show/hide</text>
                <For each={METRICS}>{([key, label], index) => (
                  <text
                    id={`${id}.setting.${key}`} flexShrink={0}
                    selectable={false}
                    fg={context.theme.text.base}
                    attributes={selected() === index() ? TextAttributes.BOLD : 0}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return;
                      setSelected(index());
                      toggleSetting(key);
                    }}
                  >
                    {`${visible(key) ? "[x]" : "[ ]"} ${label}`}
                  </text>
                )}</For>
              </box>
              <box flexShrink={0}>
                <text fg={context.theme.text.muted} attributes={TextAttributes.BOLD}>Options</text>
                <For each={OPTIONS}>{([key, label], index) => (
                  <text
                    id={`${id}.setting.${key}`} flexShrink={0}
                    selectable={false}
                    fg={context.theme.text.base}
                    attributes={selected() === METRICS.length + index() ? TextAttributes.BOLD : 0}
                    onMouseUp={(event) => {
                      if (event.button !== 0) return;
                      setSelected(METRICS.length + index());
                      toggleSetting(key);
                    }}
                  >
                    {`${settings[key] ? "[x]" : "[ ]"} ${label}`}
                  </text>
                )}</For>
              </box>
            </scrollbox>
            <text
              flexShrink={0}
              selectable={false}
              fg={context.theme.text.base}
              attributes={selected() === SETTINGS.length ? TextAttributes.BOLD : 0}
              onMouseUp={(event) => { if (event.button === 0) context.ui.dialog.clear(); }}
            >Close</text>
            <text flexShrink={0} fg={context.theme.text.muted}>↑/↓ select · Space toggle · Esc close</text>
          </box>
        );
      });
      context.ui.dialog.set({ size: "medium", centered: true });
    };
    context.keymap.layer(() => ({
      commands: [{
        id: `${id}.settings`,
        title: "Customize Session Token Summary",
        palette: true,
        run: openSettings,
      }],
    }));

    const scheduleRefresh = () => {
      if (disposed || !lastSessionID) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(lastSessionID);
      }, REFRESH_DELAY_MS);
    };

    const refresh = async (sessionID: string) => {
      if (disposed || !sessionID) return;
      const currentLoadID = ++loadID;
      const showCacheMisses = settings.cacheMissNotices === true;

      try {
        const [root, descendants, rootMessages] = await Promise.all([
          context.client.session.get({ sessionID }),
          fetchDescendants(context.client, sessionID, showCacheMisses),
          fetchSessionMessages(context.client, sessionID, showCacheMisses),
        ]);
        if (disposed || currentLoadID !== loadID) return;

        knownSessionIDs = new Set([sessionID, ...descendants.sessions.map((session) => session.id)]);
        const assistantMessages = [...rootMessages.filter(isAssistant), ...descendants.messages];
        const totals: UsageState = {
          ...sumSessions([root, ...descendants.sessions], assistantMessages.length),
          status: "ready",
          costMode: "reported",
          weightedUsd: 0,
          cny: 0,
        };

        let models: Awaited<ReturnType<typeof context.client.model.list>>["data"] = [];
        if (assistantMessages.some((message) => message.cost === 0 && message.tokens)) {
          try {
            const catalog = await context.client.model.list({ location: context.location });
            models = catalog.data;
          } catch {
            // Pricing is optional; reported session totals remain available.
          }
        }
        const costBreakdown = computeCostBreakdown(
          [root, ...descendants.sessions],
          assistantMessages,
          models,
          costOptions,
          [
            { sessionID: root.id, messages: rootMessages.filter(isAssistant) },
            ...descendants.messageGroups,
          ],
        );
        totals.cost = costBreakdown.cost;
        totals.costMode = costBreakdown.mode;
        totals.weightedUsd = costBreakdown.weightedUsd;
        totals.cny = costBreakdown.cny;

        if (disposed || currentLoadID !== loadID) return;
        setState(totals);
        if (showCacheMisses && settings.cacheMissNotices) {
          const misses = [...detectCacheMisses(rootMessages, sessionID), ...descendants.cacheMisses];
          for (const id of knownSessionIDs) {
            const seen = seenMisses.get(id);
            const baseline = seen ?? new Set<string>();
            for (const miss of misses.filter((miss) => miss.sessionID === id)) {
              if (seen && !seen.has(miss.messageID) && miss.missedTokens >= 20_000) {
                const reason = miss.modelChanged ? " after model switch"
                  : miss.idleMs >= 5 * 60_000 ? ` after ${Math.round(miss.idleMs / 60_000)}m idle` : "";
                context.ui.toast.show({
                  title: `Possible cache miss${reason}`,
                  message: `${fmt(miss.missedTokens)} previously processed tokens weren’t read from cache.`,
                  variant: "warning",
                  sessionID: miss.sessionID,
                });
              }
              baseline.add(miss.messageID);
            }
            seenMisses.set(id, baseline);
          }
        }
      } catch (error) {
        if (disposed || currentLoadID !== loadID) return;
        if (state().status !== "ready") {
          setState({ ...EMPTY, status: "error", error: errorMessage(error) });
        }
      }
    };

    const refreshForKnownSession = (sessionID: string) => {
      if (knownSessionIDs.has(sessionID)) scheduleRefresh();
    };

    createEffect(on(() => settings.cacheMissNotices, () => {
      seenMisses.clear();
      ++loadID;
      scheduleRefresh();
    }, { defer: true }));

    const stopStepEnded = context.data.on("session.step.ended", (event) => {
      if (settings.cacheMissNotices) refreshForKnownSession(event.data.sessionID);
    });
    const stopUsageUpdate = context.data.on("session.usage.updated", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopExecution = context.data.on("session.execution.succeeded", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopSessionCreated = context.data.on("session.created", (event) => {
      if (event.data.parentID && knownSessionIDs.has(event.data.parentID)) {
        if (!knownSessionIDs.has(event.data.sessionID) && settings.cacheMissNotices) {
          seenMisses.set(event.data.sessionID, new Set());
        }
        knownSessionIDs.add(event.data.sessionID);
        ++loadID;
        scheduleRefresh();
      }
    });
    const stopSessionDeleted = context.data.on("session.deleted", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        createEffect(() => {
          const sessionID = props.sessionID;
          if (sessionID !== lastSessionID) {
            lastSessionID = sessionID;
            knownSessionIDs = new Set([sessionID]);
            seenMisses.clear();
            setState({ ...EMPTY });
            void refresh(sessionID);
          }
        });

        const totalTokens = () => {
          const usage = state();
          return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
        };
        const cacheHit = () => {
          const usage = state();
          const base = usage.input + usage.cacheWrite;
          if (settings.cachePercentage) {
            const total = base + usage.cacheRead;
            return total === 0 ? "—" : `${(usage.cacheRead / total * 100).toFixed(1)}%`;
          }
          if (base === 0) return usage.cacheRead > 0 ? "∞" : "—";
          return `${(usage.cacheRead / base).toFixed(1)}×`;
        };
        const costColor = () => {
          return costColorForCny(state().cny, {
            info: context.theme.text.feedback.info.base,
            warning: context.theme.text.feedback.warning.base,
            error: context.theme.text.feedback.error.base,
          });
        };
        const cnyLabel = () => state().costMode === "estimated"
          ? "估算消耗 CNY"
          : state().costMode === "mixed"
            ? "消耗 CNY（含估算）"
            : "实际消耗 CNY";

        return (
          <box gap={0}>
            <box flexDirection="row" justifyContent="space-between">
              <text
                selectable={false}
                fg={context.theme.text.base} attributes={TextAttributes.BOLD}
                onMouseUp={(event) => { if (event.button === 0) openSettings(); }}
              >Session Token Summary</text>
              <Show when={visible("turns", state().turns)}>
                <text fg={context.theme.text.muted}>{"↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s")}</text>
              </Show>
            </box>
            <Show when={state().status === "loading"}>
              <text fg={context.theme.text.muted}>Loading…</text>
            </Show>
            <Show when={state().status === "error"}>
              <text fg={context.theme.text.feedback.error.base}>{state().error || "Unknown error"}</text>
            </Show>
            <Show when={state().status === "ready"}>
              <box gap={0}>
                <Show when={visible("input", state().input)}>
                  <UsageRow label="↑ input" value={fmt(state().input)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("output", state().output)}>
                  <UsageRow label="↓ output" value={fmt(state().output)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheWrite", state().cacheWrite)}>
                  <UsageRow label="▤ cache write" value={fmt(state().cacheWrite)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheRead", state().cacheRead)}>
                  <UsageRow label="▤ cache read" value={fmt(state().cacheRead)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("cacheRatio", state().cacheRead)}>
                  <UsageRow label="ø cache hit" value={cacheHit()} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("reasoning", state().reasoning)}>
                  <UsageRow label="✦ think" value={fmt(state().reasoning)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                </Show>
                <Show when={visible("total", totalTokens())}>
                  <box height={1} border={["top"]} borderColor={context.theme.border.base} />
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>Σ total</text>
                    <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>{fmt(totalTokens())}</text>
                  </box>
                </Show>
                <Show when={visible("cost", state().cost)}>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>
                      {state().costMode === "estimated"
                        ? "$ est. cost"
                        : state().costMode === "mixed"
                          ? "$ cost incl. est."
                          : "$ cost"}
                    </text>
                    <text fg={costColor()}>{fmtCost(state().weightedUsd)}</text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>{cnyLabel()}</text>
                    <text fg={costColor()}>{fmtCny(state().cny)}</text>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        );
      },
    });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      stopUsageUpdate();
      stopStepEnded();
      stopExecution();
      stopSessionCreated();
      stopSessionDeleted();
      stopSlot();
    };
  },
});

function UsageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.labelColor}>{props.label}</text>
      <text fg={props.valueColor}>{props.value}</text>
    </box>
  );
}
