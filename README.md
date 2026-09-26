# fast-jev-opencode

[![CI](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml)

Verbatim context pruning for [OpenCode](https://opencode.ai) **v1 and v2**, powered by
[TypeSafe Jev](https://docs.typesafe.ai). Instead of summarizing old turns, it scores every
tool call and tool result with Jev and removes or truncates only the stale ones. Everything
that stays is kept word for word.

One package, two adapters. The v2 adapter uses `ctx.session.hook("context", ...)`; the v1
adapter uses the legacy `experimental.chat.messages.transform` hook. The upstream

Claude Code and invented the approach. This project is an independent implementation of the
same idea: the engine under `src/engine/` is our own code, with no dependency on that
package — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for why.

## Compatibility

| Host                | Entry        | Hook                                   | Minimum                       |
| ------------------- | ------------ | -------------------------------------- | ----------------------------- |
| OpenCode **v2**     | `setup()`    | `ctx.session.hook("context", ...)`     | any v2                        |
| OpenCode **v1**     | `server()`   | `experimental.chat.messages.transform` | 1.18.29+ (object entrypoints) |
| OpenCode v1 (older) | plugin array | `experimental.chat.messages.transform` | pin `#v0.1.0`                 |

Both entrypoints are exported from one default export, the shape documented in
[the v2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1):

```ts
export default {
  ...FastJevV2, // V2 calls setup()
  async server(input, options) {
    return FastJevV1(input, options) // V1 calls server()
  },
}
```

A difference worth knowing: in v1 the message hook also runs for the request that builds a
`/compact` summary, so the pruner saw that request too. In v2 `context` covers only the agent
loop — compaction is a separate hook this plugin does not register.

## How it works

```
outgoing request -> map OpenCode messages to the library message model
                 -> ask Jev two noul questions per candidate tool call
                    (keep the call? keep the result?)
                 -> drop_call / drop_result / keep
                 -> rewrite only the outgoing request
```

A candidate is a tool call that is not pinned (first message / newest
`preserveRecentMessages`), whose result is at least `minResultChars`, and whose tool is not in
`protectTools`.

- **Non-destructive:** persisted history, the UI, and stored sessions are never modified. Only
  the request sent to the model is changed.
- **Verbatim:** user and assistant text is never rewritten. Only tool calls are dropped and
  tool outputs truncated.
- **Fail-open:** a missing key, timeout, transport error, malformed answer, or unreadable
  config leaves the request untouched.
- **Cached:** decisions are cached per tool call id, so the same call is not re-scored on every
  request (`rejudgeAfterMs`).
- **Redacted:** tool inputs lose credential-named fields and secret-shaped strings before
  anything is sent to the Jev endpoint.
- **Informed:** each result reaches Jev as a size plus a head/tail excerpt (`peekChars`), so the
  judgement is made on what the output contained rather than on a byte count.
- **Guarded:** a pass that scored `minScored` calls and kept none is refused outright — a
  blanket removal is a bad answer, not a decision, and the request goes out untouched.
- **Free where provable:** the transcript sometimes proves a call is stale by itself — an
  identical request made later, or an error an identical later request resolved. Those are
  dropped with **zero** Jev requests. The `superseded` rule (a read modified by a later edit)
  ships **off**: `bench:baseline` measured it costing more later-referenced evidence than it
  saves requests.
- **Cost-aware (optional):** set `inputPrice` / `cachedInputPrice` and `cacheAware: true` and a
  prune is refused when the cache it invalidates costs more than the tokens it removes. Left
  off by default because pricing varies by provider and contract.
- **Verbatim checkpoint (opt-in):** `verbatimCheckpoint: true` makes compaction record the
  messages themselves — text word for word, tool outputs cut to a bounded head — instead of the
  model-written summary. What survives compaction is then the history rather than a description
  of it. Off by default, and skipped when the rendering would exceed
  `verbatimCheckpointMaxChars`, so the host's own compaction stays in charge if anything is
  uncertain.
- **Shape-preserving:** a call Jev rates as no longer needed keeps its place with the output
  cut short (`removedCallStyle: "stub"`). Deleting it leaves the assistant's narration with no
  evidence behind it, and a model that sees that shape starts reporting work it never did —
  the failure reported upstream as

  smaller, older behaviour.

## Install

### OpenCode v2

```sh
opencode plugin add github:roshan-shaik-ml/fast-jev-opencode
```

Or reference it from `~/.config/opencode/opencode.json` as a package:

```jsonc
{
  "plugins": ["fast-jev-opencode"],
}
```

### OpenCode v1 (1.18.29+)

Add the package to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git"],
}
```

### OpenCode v1 (older than 1.18.29)

Older releases cannot load an object entrypoint. Pin the v1-only release:

```jsonc
{
  "plugin": [
    "fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git#v0.1.0",
  ],
}
```

### Finish setup

1. Add the plugin config file:

   ```sh
   cd ~/.config/opencode
   curl -fsSL -o fast-jev.json \
     https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/fast-jev.example.json
   ```

2. Add your Jev key - see [TypeSafe API key](#typesafe-api-key).

3. Restart OpenCode. It starts in `dryRun` mode, so nothing is pruned until you set
   `"dryRun": false` in `fast-jev.json`.

## TypeSafe API key

The plugin needs a Jev key. Create one in the TypeSafe console at
<https://console.typesafe.ai>, then give it to the plugin.

`apiKeyEnv` (default `TYPESAFE_API_KEY`) is the environment-variable **name** the plugin looks
up. The key is resolved in this order, first hit wins:

1. `apiKey` in `~/.config/opencode/fast-jev.json` (inline; not recommended)
2. the `TYPESAFE_API_KEY` environment variable of the **OpenCode server process**
3. a `TYPESAFE_API_KEY=...` line in `~/.config/opencode/.env` (easiest)
4. the contents of the file named by `apiKeyFile`

### Option 1 - the `.env` file (recommended)

```sh
printf 'TYPESAFE_API_KEY=your-key-here\n' >> ~/.config/opencode/.env
```

Keep `.env` out of version control.

### Option 2 - the server environment

```sh
# macOS / Linux
export TYPESAFE_API_KEY=your-key-here
opencode
```

```powershell
# Windows PowerShell
$env:TYPESAFE_API_KEY = "your-key-here"; opencode
```

### Option 3 - inline in the config

Only if you cannot use an environment variable:

```json
{ "apiKey": "your-key-here" }
```

### Using another provider

Set `provider` in `fast-jev.json` to `zen` or `openrouter` and supply that provider's key
instead (`OPENCODE_API_KEY` or `OPENROUTER_API_KEY`). For anything else, use
`provider: "custom"` with `baseUrl`, `model`, and `apiKeyEnv`.

Without a valid key the plugin fails open: it logs a warning and sends the request unchanged.

## Configure

`~/.config/opencode/fast-jev.json` is re-read on every request, so edits apply without a
restart. The shipped example is observe-only (`dryRun: true`).

| Option                       | Default    | Meaning                                                                        |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `enabled`                    | `true`     | Master switch                                                                  |
| `dryRun`                     | `true`     | Score and log, but do not rewrite the request                                  |
| `provider`                   | `typesafe` | `typesafe`, `zen`, `openrouter`, or `custom`                                   |
| `baseUrl`                    | preset     | System One endpoint (required for `custom`)                                    |
| `model`                      | preset     | Jev model id                                                                   |
| `apiKey`                     | `""`       | Inline key (prefer `apiKeyEnv`)                                                |
| `apiKeyEnv`                  | preset     | Environment variable holding the key                                           |
| `apiKeyFile`                 | `""`       | File containing the key                                                        |
| `keepCallThreshold`          | `0.25`     | Minimum probability for the call itself to stay                                |
| `keepResultThreshold`        | `0.15`     | Minimum probability for its output to stay verbatim                            |
| `keepThreshold`              | _unset_    | Legacy override: sets both thresholds to one value                             |
| `questionStyle`              | `choice`   | `choice` asks one three-way question per call; `noul` asks two                 |
| `preserveRecentMessages`     | `6`        | Newest messages never judged                                                   |
| `maxStateTokens`             | `25000`    | State token ceiling                                                            |
| `maxRequestTokens`           | `30000`    | State plus one batch of questions                                              |
| `truncateHeadChars`          | `300`      | Head kept when a result is truncated                                           |
| `minResultChars`             | `2000`     | Results below this are never candidates                                        |
| `peekChars`                  | `200`      | Head/tail excerpt of each result shown to Jev                                  |
| `minScored`                  | `8`        | Refuse a pass that scored this many calls and kept none                        |
| `removedCallStyle`           | `"stub"`   | `"stub"` keeps a removed call with its output cut short; `"delete"` removes it |
| `rules`                      | see below  | Free drops proved by the transcript, with no Jev request                       |
| `inputPrice`                 | `0`        | USD per million input tokens, for cost reporting (`0` = off)                   |
| `cachedInputPrice`           | `0`        | USD per million cached input tokens                                            |
| `cacheAware`                 | `false`    | Refuse a prune that does not pay for itself at those prices                    |
| `verbatimCheckpoint`         | `false`    | At compaction, record the messages themselves instead of a summary             |
| `verbatimCheckpointMaxChars` | `200000`   | Skip the checkpoint above this size and keep the host's summary                |
| `protectTools`               | `[]`       | Tool names whose calls/results are always kept                                 |
| `rejudgeAfterMs`             | `600000`   | Re-score a call after this long; `0` re-scores every request                   |
| `timeoutMs`                  | `30000`    | Per-request deadline; a stalled endpoint fails open                            |
| `log`                        | `true`     | Structured logging via the host client                                         |

Set `FAST_JEV_CONFIG` to point the plugin at a different config file (used by the tests).

Provider presets:

| provider     | endpoint                         | model               | key                        |
| ------------ | -------------------------------- | ------------------- | -------------------------- |
| `typesafe`   | `api.typesafe.ai/v1/systemone`   | `jev-latest`        | `TYPESAFE_API_KEY`         |
| `zen`        | `opencode.ai/zen/v1/systemone`   | `jev-1.13-free`     | `OPENCODE_API_KEY`         |
| `openrouter` | `openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY`       |
| `custom`     | _required_                       | _required_          | via `apiKey` / `apiKeyEnv` |

## Benchmark

Two scripts, both runnable without a key (they stub Jev). Add `-- --live` and set
`TYPESAFE_API_KEY` to score against the real endpoint.

```sh
npm run bench          # engine <-> adapter consistency
npm run bench:savings  # token savings, with and without Jev
```

### Engine and adapter agree

Drives the engine's decision path and the adapter over the same transcript with the same
stubbed Jev answers:

```
transcript: 31 messages, 24 tool calls
engine     actions {"keep":16,"drop_result":8,"drop_call":0}
adapter    actions {"keep":16,"drop_result":8,"drop_call":0}
           chars 97624 -> 68483
consistency  actions identical: true (24/24)
cache        second request: 0 jev request(s)
overhead     no eligible calls: 1 ms (mapping only, no Jev call)
```

The adapter adds milliseconds and no decisions of its own.

### Token savings, with and without Jev

Replays a small realistic task - fix a failing `/login` test - and measures the tokens in the
outgoing request before and after pruning. Offline the answers are stubbed; `-- --live` scores
them against the real endpoint.

```
transcript     14 messages, 6 tool calls
without Jev    1610 tokens

by keepThreshold (legacy single-knob mode):
  threshold   tokens   saved     actions
  0.50          941    - 41.6%   keep=3 drop_result=3 drop_call=0
  0.15         1610    -  0.0%   keep=6 drop_result=0 drop_call=0
```

With the shipped defaults (`keepCallThreshold` 0.5 / `keepResultThreshold` 0.25) the same
transcript keeps every call and truncates the three bulky outputs: the edit and the passing
test run survive, which is the point of splitting the thresholds. An earlier single-threshold
default of 0.5 removed all six calls on this transcript - including the edit - which is what
prompted the split.

Three passes cost **one** Jev request: decisions are cached and re-decided locally when a
threshold changes.

Tokens are estimated with the same estimator the plugin uses to plan requests, not
provider-billed tokens.

### Selection vs plain truncation

`npm run bench:baseline` runs the same transcript through the plugin and through uniform
head+tail truncation **equalised to the same retained size**, then scores each on how much of
the content the session later referred to it destroyed:

```
6 calls eligible | 5 hold something referred to later (23 evidence tokens)
pool        ours 2193 chars | head+tail 2191 chars (equalised at 65.1%)

            needed calls intact   evidence tokens kept
ours            4/5                   19/23
head+tail       2/5                   17/23
```

Selection wins on this fixture. That is one small fixture with stubbed answers, not a
statistical claim - an independent replay over real Claude Code sessions found smart selectors
barely beat head+tail at equal size (upstream

run against your own transcripts, not a settled result.

### On a real session

`npm run bench:replay` reads OpenCode's own SQLite store (`~/.local/share/opencode/opencode.db`,
read-only) and runs the same comparison over a session that actually happened:

```
session      "Investigating fast-jev" — 400 messages, 447 tool calls
chars        1,146,807 = 131k prose + 497k tool inputs + 518k tool outputs

                       chars before   after    saved   jev requests
ours (defaults)          1,146,807   847,062   26.1%      1
aggressive settings      1,146,807   603,577   47.4%      7
```

Two things to read from that. The **defaults give up about twenty points** to the aggressive
settings - that gap is `minResultChars` (only outputs over 2000 characters are candidates) and
`removedCallStyle: "stub"` instead of deleting calls outright. And roughly **half the payload in
a real session is tool _inputs_** - edit payloads, shell bodies - which is why clearing outputs
alone tops out around 10%: a call whose output is cleared but whose input still ships has only
been half removed.

The evidence comparison on the same session is roughly a tie with plain truncation, which
matches the independent replay quoted above. So install this for the safety - pairing
preserved, text untouched, secrets redacted, failures failing open - not for a magic number.

### Question shape and threshold calibration

`npm run bench:ab` replays a real session against the live endpoint, once per configuration,
and reports both what was saved and how much later-referenced content survived. Four arms on
one 400-message session:

```
arm                saved  requests     ms   needed calls   evidence kept
noul   0.50/0.25   34.9%         1   1451    165/206      1616/4060  (40%)
choice 0.50/0.25   30.3%         1    619    171/206      1981/4060  (49%)
noul   0.25/0.15   16.6%         1    608    182/206      2802/4060  (69%)
choice 0.25/0.15   20.6%         1    827    182/206      2710/4060  (67%)
```

Two conclusions drove the shipped defaults:

- **`choice` beats `noul`.** At matched thresholds it keeps more of what the session later
  used, in half the latency, because one question replaces two.
- **The thresholds were wrong.** On this traffic `noul` readings sat at 0.26-0.42 for calls and
  0.09-0.21 for results, so the old `0.5 / 0.25` made `keep` **unreachable** - the defect

  present here because the numbers had been borrowed rather than measured. At `0.25 / 0.15`
  the same session gives up about fourteen points of saving to keep far more of what mattered.

Defaults are therefore `questionStyle: "choice"` with `0.25 / 0.15`. Raise them if you want the
savings back and accept the loss.

## Test

Offline; no network and no key. Each suite starts a local mock System One endpoint and drives
the real entrypoint: `test/v1.test.mjs` through the v1 hook, `test/v2.test.mjs` through
`setup()` / `server()`. Requires Node >= 22.6 (the runner uses
`--experimental-strip-types`).

```sh
npm test
npm run format:check
```

## Credits

- Prior art: the approach was invented in

  This project is an independent implementation and shares no code with it.
- Decisions: [TypeSafe Jev](https://docs.typesafe.ai)

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the upstream license notice.

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with TypeSafe or OpenCode.
