# OpenCode Session Token Summary

[![npm version](https://img.shields.io/npm/v/opencode-plugin-session-token-summary)](https://www.npmjs.com/package/opencode-plugin-session-token-summary)

An OpenCode TUI plugin that adds a compact session-usage panel to the sidebar.
It aggregates the root session and all nested subagent sessions.

![Session Token Summary sidebar panel](sidebar.png)

## Features

- Compact OpenCode sidebar panel with live session updates
- Click the panel title to customize visible metrics and see the plugin version
- Input, output, reasoning, cache read, cache write, and total token counts
- Cache hit (ratio or percentage) and assistant turn count
- Usage aggregated across the root session and every nested subagent
- Reported API costs for metered providers
- API-equivalent cost estimates for quota and subscription-backed providers
- One combined cost total for sessions that mix metered and quota-backed models
- Clear labels distinguishing reported, estimated, and partially estimated costs
- V2 model-catalog pricing with context-tier support

## Compatibility

| OpenCode version | Plugin version | Installation |
| --- | --- | --- |
| OpenCode V2 (`opencode`, `>=2.0.28 <3`) | `2.x` | Use the V2 instructions below. |
| OpenCode V1 | `0.4.1` | Install the pinned legacy package with the V1 instructions below. |

## OpenCode 2 Install

Add the npm package to `~/.config/opencode/cli.json`, or replace its existing
entry. Preserve other plugins and settings:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "opencode-plugin-session-token-summary@^2"
  ]
}
```

OpenCode installs the package from npm automatically. Restart the TUI if it does
not reload.

For a local checkout, configure the plugin directory as an object and set the
cost multipliers in `options`. Top-level values are the fallback for providers
without an override:

```json
{
  "package": "E:/path/to/opencode-plugin-session-token-summary",
  "options": {
    "usdMultiplier": 1,
    "rechargeCnyPerUsd": 7.2,
    "providers": {
      "anthropic": {
        "usdMultiplier": 1.1,
        "rechargeCnyPerUsd": 7.2
      },
      "openai": {
        "usdMultiplier": 1,
        "rechargeCnyPerUsd": 7.5
      },
      "deepseek": {
        "currency": "CNY",
        "pricingMode": "deepseek-schedule"
      }
    }
  }
}
```

Provider keys must exactly match OpenCode provider IDs. For each provider, the
displayed USD subtotal is its raw USD cost multiplied by `usdMultiplier`; the
CNY subtotal is that weighted USD amount multiplied by `rechargeCnyPerUsd`.
Provider values fall back independently to their top-level counterpart, whose
defaults are `1` and `7.2`. Missing, negative, non-finite, or non-numeric
values use the corresponding fallback. Costs that cannot be attributed to a
provider use the top-level values. For example, a `$1.00` provider subtotal
with a `1.2` multiplier and `7.2` CNY rate displays as `$1.20` and `¥8.64`.

DeepSeek can be configured for native CNY pricing instead of OpenCode's static
USD catalog:

```json
{
  "package": "E:/path/to/opencode-plugin-session-token-summary",
  "options": {
    "currency": "USD",
    "pricingMode": "standard",
    "providers": {
      "deepseek": {
        "currency": "CNY",
        "pricingMode": "deepseek-schedule"
      }
    }
  }
}
```

`currency` accepts `USD` or `CNY`; `pricingMode` accepts `standard` or
`deepseek-schedule`. Provider values override the corresponding top-level
value. DeepSeek schedule mode requires both `currency: "CNY"` and
`pricingMode: "deepseek-schedule"`. The schedule mode is opt-in and only
applies to the provider ID whose configuration contains it; unrelated
providers and model IDs are not inferred to be DeepSeek.

For a configured DeepSeek schedule provider, `deepseek-flash` and
`deepseek-v4-pro` are billed directly in CNY per million tokens. The formula is
`(input × inputRate + cacheRead × cacheHitRate + (output + reasoning) ×
outputRate) / 1,000,000`; cache write tokens are not separately charged by this
schedule. Flash rates are `1 / 0.02 / 4` off-peak and `2 / 0.04 / 8` peak for
input/cache-hit/output. V4 Pro rates are `4.5 / 0.15 / 13.5` off-peak and
`9 / 0.30 / 27` peak. Peak windows use the message timestamp in
`Asia/Shanghai`: weekdays 09:00–12:00 and 14:00–18:00, left-closed and
right-open. Weekends remain off-peak even when the official calendar marks a
makeup workday. Native-CNY amounts are authoritative and are never multiplied
by `usdMultiplier`, converted through `rechargeCnyPerUsd`, or included in the
weighted USD subtotal.

The bundled annual calendar is maintained in [`holiday.ts`](holiday.ts). It
contains the official 2026 schedule and records makeup workdays for reference.
The source is the State Council General Office notice:
[国务院办公厅关于2026年部分节假日安排的通知](https://www.scio.gov.cn/zdgz/jj/202511/t20251110_938367.html).
Missing years intentionally throw `MissingHolidayCalendarError`; the plugin
reports that as a red cost error instead of silently using the current date or
an estimated/static model price.

### Updating the annual holiday calendar

This plugin does not query a third-party holiday API at runtime. When the State
Council publishes the official schedule for a new year:

1. Add the year's holiday dates and makeup workdays to `holiday.ts`.
2. Add the official source URL and publication reference in a source comment.
3. Add tests for Beijing time-zone conversion, peak-window boundaries,
   holidays, weekends, and makeup-workday weekends.
4. Run the repository checks:

   ```sh
   npm run check
   npm run pack:check
   ```

5. Rebuild the local plugin with `npm run build` if the check did not already
   rebuild it.
6. Completely exit and restart the OpenCode TUI.
7. Commit the calendar, tests, and documentation:

   ```sh
   git add holiday.ts test README.md
   git commit -m "data: add YYYY China holiday calendar"
   ```

Do not add a year before its official schedule is published. If a session
contains a message from a year that is not in `holiday.ts`, the sidebar keeps
Token/cache/subagent rows but reports a cost-calculation error.

Dynamic DeepSeek messages use `message.time.created`, falling back to
`message.time.completed` only when `created` is absent. If both timestamps,
the annual calendar, or the model schedule price is unavailable, the sidebar
shows a cost error while retaining token, cache, turn, and subagent rows.

The `0.4.x` package targets the legacy TUI plugin API and cannot be used with
OpenCode 2.

## OpenCode V1 Install

OpenCode V1 users must install the final legacy release, `0.4.1`:

1. Press `Ctrl+P` in OpenCode and choose **Install plugin**.
2. Press `Tab` to install globally.
3. Enter `opencode-plugin-session-token-summary@0.4.1`.

This creates an entry in `~/.config/opencode/tui.json`. Do not install an
unversioned package in V1, because later releases target OpenCode 2.

## Notes

Click **Session Token Summary** in the sidebar, or press `Ctrl+P` and choose
**Customize Session Token Summary**, to open the settings popup. Toggle metrics
with the mouse or use arrow keys and Space. Preferences apply immediately and
are saved across restarts. Choose **Close** or press Esc to dismiss the popup.
In short terminals, use arrow keys or the mouse wheel to scroll through settings.

![Session Token Summary settings modal](settings.png)

**Show/hide** controls individual metrics; thinking tokens are off by default
for new settings. **Options** lets you hide zero-valued rows or display cache
hit as a percentage. Both options are off by default. The percentage is
cache reads divided by input tokens plus cache writes and cache reads; the ratio
is cache reads divided by input tokens plus cache writes. Existing saved metric
choices are preserved.

**Show cache-miss notices** is off by default. It warns about new suspected misses
of at least 20K tokens, comparing consecutive completed requests within each
session, including subagents. It skips the first request, resets after compaction,
and requires evidence of cache activity. Opening a session or enabling the option
does not replay historical warnings. Inspired by
[Pi’s cache-miss heuristic](https://github.com/badlogic/pi-mono/blob/b45e0ebcc5ae2fc42a6f2f23104d10e656e6bedb/packages/coding-agent/src/core/cache-stats.ts),
this estimates prompt overlap, not confirmed provider failures. Model switches
and idle gaps are context hints, not proof of the cause. No cost-loss estimate is
shown; providers that do not report caching cannot be assessed.

The panel reads V2 session totals and paginated assistant messages for the
selected session and its nested descendants. It limits descendant requests to
four concurrent operations and keeps the last complete snapshot if a background
refresh fails. It works with the connected server, including remote servers,
and needs no separate API key.

With cache-miss notices enabled, message fetching also includes compaction records.

Reported costs use each OpenCode session's aggregate cost as authoritative for
standard USD providers. Root and descendant sessions are reconciled
independently against their own assistant-message costs. Message costs
attribute each session's aggregate to providers only when they do not exceed
that session total; any shortfall is unattributed and uses top-level
multipliers. If message costs exceed a session aggregate, only that session's
aggregate is treated as unattributed, without discarding valid provider
attribution from other sessions or double-counting. A session containing a
`deepseek-schedule` message is the exception: its OpenCode aggregate and
DeepSeek message `cost` values are excluded, and its direct CNY total is
calculated from tokens and the annual schedule. Non-DeepSeek messages in the
same root/descendant tree retain the normal USD reconciliation.
For messages with an explicit zero cost, the plugin uses OpenCode's model
catalog to estimate the same tokens at published API rates and applies the
original message provider's multipliers. Fully estimated totals are shown as `$ est. cost`;
totals combining reported and estimated amounts are shown as `$ cost incl.
est.` Quota or subscription users are not necessarily charged the estimate.
Catalog estimates depend on available model pricing and aliases, and may not
match provider billing, negotiated prices, or discounts. A missing or
unmatched catalog price contributes no estimate; the reported aggregate remains
available. Session totals and assistant messages are fetched from the connected
OpenCode server, while estimates use its model catalog.

## Development

```sh
npm ci
npm run check
npm run pack:check
```

To load a local checkout in OpenCode 2, run `npm ci && npm run build`, then
replace the npm entry in `~/.config/opencode/cli.json` with the checkout's
absolute directory path. Use the directory, not `tui.tsx`: OpenCode V2 resolves
the directory's `tui` entrypoint and skips direct-file TUI entries. Restart the
TUI if it does not reload.

## License

[MIT](LICENSE)
