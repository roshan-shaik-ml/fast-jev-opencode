# fast-jev-opencode

[![CI](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml)

Verbatim context pruning for [OpenCode](https://opencode.ai) **v1 and v2**, powered by
[TypeSafe Jev](https://docs.typesafe.ai). Instead of summarizing old turns, it scores every
tool call and tool result with Jev and removes or truncates only the stale ones. Everything
that stays is kept word for word.

One package, two adapters: v2 registers `ctx.session.hook("context", ...)`; v1 uses the legacy
`experimental.chat.messages.transform` hook. The engine under `src/engine/` is this project's
own implementation.

## Compatibility

| Host                | Entry        | Hook                                   | Minimum                       |
| ------------------- | ------------ | -------------------------------------- | ----------------------------- |
| OpenCode **v2**     | `setup()`    | `ctx.session.hook("context", ...)`     | any v2                        |
| OpenCode **v1**     | `server()`   | `experimental.chat.messages.transform` | 1.18.29+ (object entrypoints) |
| OpenCode v1 (older) | plugin array | `experimental.chat.messages.transform` | pin `#v0.1.0`                 |

Both entrypoints come from one default export:

```ts
export default {
  ...FastJevV2, // v2 calls setup()
  async server(input, options) {
    return FastJevV1(input, options) // v1 calls server()
  },
}
```

One difference worth knowing: in v1 the message hook also runs for the request that builds a
`/compact` summary, so the pruner sees that request too, and the old hook payload does not say
which kind of request it is. In v2 `context` covers only the agent loop; compaction is a
separate hook this plugin touches only when `verbatimCheckpoint` is enabled, which it is not by
default.

## Install

```sh
# OpenCode v2
opencode plugin add github:roshan-shaik-ml/fast-jev-opencode
```

```jsonc
// OpenCode v1 (1.18.29+) — ~/.config/opencode/opencode.json
{ "plugin": ["fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git"] }
```

Versions older than 1.18.29 cannot load an object entrypoint; pin `#v0.1.0` on the same spec.

Then:

1. Copy the example config to `~/.config/opencode/fast-jev.json` (also
   [viewable in the repo](./fast-jev.example.json)).
2. Add your Jev key — see below.
3. Restart OpenCode. It starts in `dryRun` mode, so nothing is pruned until you set
   `"dryRun": false`.

## TypeSafe API key

Create a key at <https://console.typesafe.ai>. The plugin resolves it in this order, first hit
wins: inline `apiKey`, the `TYPESAFE_API_KEY` variable of the OpenCode process, a
`TYPESAFE_API_KEY=...` line in `~/.config/opencode/.env` (easiest), or the file named by
`apiKeyFile`.

```sh
printf 'TYPESAFE_API_KEY=your-key-here\n' >> ~/.config/opencode/.env
```

For `provider: "zen"` or `"openrouter"`, supply `OPENCODE_API_KEY` or `OPENROUTER_API_KEY`
instead. Without a valid key the plugin fails open: it warns and sends the request unchanged.

## Configure

`~/.config/opencode/fast-jev.json` is re-read on every request, so edits apply without a
restart. `FAST_JEV_CONFIG` points the plugin at a different file. The
[example config](./fast-jev.example.json) lists every option; the ones worth knowing:

| Option                   | Default    | Meaning                                                              |
| ------------------------ | ---------- | -------------------------------------------------------------------- |
| `dryRun`                 | `true`     | Score and log, but do not rewrite the request                        |
| `provider`               | `typesafe` | `typesafe`, `zen`, `openrouter`, or `custom`                         |
| `keepCallThreshold`      | `0.25`     | Minimum probability for the call itself to stay                      |
| `keepResultThreshold`    | `0.15`     | Minimum probability for its output to stay verbatim                  |
| `questionStyle`          | `choice`   | `choice` asks one three-way question per call; `noul` asks two       |
| `preserveRecentMessages` | `6`        | Newest messages never judged                                         |
| `minResultChars`         | `2000`     | Results below this are never candidates                              |
| `removedCallStyle`       | `"stub"`   | Keep a dropped call with its output cut short, or `"delete"` it      |
| `protectTools`           | `[]`       | Tool names whose calls/results are always kept                       |
| `cacheAware`             | `false`    | With `inputPrice` / `cachedInputPrice`, refuse prunes that cost more |
| `verbatimCheckpoint`     | `false`    | At compaction, record the messages themselves instead of a summary   |
| `effortEnabled`          | `false`    | v2: let Jev choose the request's reasoning effort (see below)        |
| `effortLevels`           | see below  | Levels offered when the model declares none of its own               |
| `logFile`                | `""`       | v2 only: append decisions to this file; `~` is expanded (see below)  |
| `log`                    | `true`     | Structured logging via the host client                               |

Presets: `typesafe` (`api.typesafe.ai/v1/systemone`, `jev-latest`), `zen`
(`opencode.ai/zen/v1/systemone`, `jev-1.13-free`), `openrouter`
(`openrouter.ai/api/v1/systemone`, `typesafe/jev-1.13`). `custom` needs `baseUrl` and `model`.

## How it works

```
outgoing request -> map OpenCode messages to the message model
                 -> ask Jev one choice question per candidate tool call
                    (keep / drop the result / drop the call too)
                 -> rewrite only the outgoing request
```

A candidate is a tool call that is not pinned (first message / newest
`preserveRecentMessages`), whose result is at least `minResultChars`, and whose tool is not in
`protectTools`.

- **Non-destructive:** persisted history, the UI, and stored sessions are never modified — only
  the request sent to the model.
- **Verbatim:** user and assistant text is never rewritten; only tool calls are dropped and
  tool outputs truncated.
- **Fail-open:** a missing key, timeout, transport error, malformed answer, or unreadable config
  leaves the request untouched.
- **Redacted:** tool inputs lose credential-named fields and secret-shaped strings before
  anything is sent to the Jev endpoint.
- **Informed and guarded:** each result reaches Jev as a size plus a head/tail excerpt
  (`peekChars`); a pass that scored `minScored` calls and kept none is refused outright, because
  a blanket removal is a bad answer rather than a decision.
- **Free where provable:** an identical later request, or an error an identical later request
  resolved, is dropped with zero Jev requests. The `superseded` rule ships off — it cost more
  later-referenced evidence than it saved.
- **Shape-preserving:** a call rated as no longer needed keeps its place with the output cut
  short (`removedCallStyle: "stub"`). Deleting it leaves the assistant's narration with no
  evidence behind it.
- **Cached and cost-aware:** decisions are cached per call id (`rejudgeAfterMs`); with
  `inputPrice` / `cachedInputPrice` and `cacheAware: true` a prune is refused when the cache it
  invalidates costs more than the tokens it removes.

## Effort selection

Off by default; set `effortEnabled: true` to use. Before the pruning pass the plugin asks
Jev one question — how much reasoning does this request need? — and records the answer as an
`effort` part on the outgoing request. The host resolves that into whatever the provider
speaks: OpenAI's `reasoning_effort`, a thinking budget, or a boolean and a budget. The plugin
never writes provider dialect itself, which matters because every provider expresses effort
differently.

The levels offered to Jev are computed for the target model, first hit wins:

1. `effortModels["provider/model"]`, or `effortModels["provider"]`, from your config.
2. The variants that model declares — the host's own idea of effort for it.
3. `effortLevels`, default `["low", "medium", "high"]`: the slice essentially every provider
   expresses, so a choice is always expressible.

The part is injected **only** when the host explicitly declares
`compatibility.supportsEffortUpdates: true` for the model. Silence is not permission: a protocol
that does not expect an effort part rejects the entire request (an OpenAI-chat run fails with
"user messages only support text and media content"), so anything other than an explicit yes
does nothing. The decision is cached per session and digest for `rejudgeAfterMs`, so a turn asks
once, and a failure fails open with the request untouched. v1 has no effort parts, so this is
v2-only.

## Watching it work

v2 hands plugins no log sink, so the plugin's output has nowhere to go unless you give it a
file:

```json
{ "logFile": "~/.local/share/opencode/fast-jev.log" }
```

One line per decision, counts only — no prompts, no tool output, no keys:

```
2026-09-27T00:12:03Z [fast-jev] info: pruned outgoing request {"droppedCalls":0,"stubbedCalls":1,"droppedResults":2,"removedMessages":0,"ruleDrops":0,"requests":1,"stateTokens":8159,"estimatedCostUsd":0,"stage":"full"}
```

Set `logFile` alone and logging turns on; setting `log: false` with a `logFile` present is
treated as "log to the file only". The file rotates to `.old` at 2 MB.

This option is v2-only and ignored by the v1 adapter, which needs no file: v1's host surfaces
plugin logs itself through `client.app.log`.

A quiet file is not always a fault. Nothing is judged unless a result is at least
`minResultChars` (2000 by default) and older than the newest `preserveRecentMessages` messages,
and a pass that scored `minScored` calls without keeping any is refused on purpose. Short
sessions legitimately produce nothing.

## Measured

```sh
npm run bench           # engine <-> adapter consistency
npm run bench:savings   # token savings, with and without Jev
npm run bench:baseline  # selection vs plain head+tail truncation, size-equalised
npm run bench:replay    # the same over a real session from OpenCode's SQLite store
```

`bench` drives the engine and the adapter over the same transcript with the same stubbed
answers and finds them identical on all 24 decisions. `bench:replay` across eight real sessions
saves **25.3%** of outgoing request characters on average with the shipped defaults and 42.5%
with aggressive settings; roughly half of a real session's payload is tool _inputs_, which is
why clearing outputs alone tops out near 10%.

Selection is not magic: size-equalised against plain head+tail truncation it keeps comparable
evidence, so install this for the safety — pairing preserved, text untouched, secrets redacted,
failures failing open — not for the number. Defaults were calibrated from live `choice` answers
on real sessions, where call readings sat at 0.26–0.42 and results at 0.09–0.21; the older
0.5/0.25 pair made `keep` unreachable. Tokens are estimated with the plugin's own estimator,
not provider-billed tokens.

## Development

```sh
npm test               # offline, no key: mock endpoint, both hooks
npm run format:check
```

Requires Node >= 22.6 (`--experimental-strip-types`).

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with TypeSafe or OpenCode.
