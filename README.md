# fast-jev-opencode

[![CI](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/roshan-shaik-ml/fast-jev-opencode/actions/workflows/ci.yml)

Verbatim context pruning for [OpenCode](https://opencode.ai) **v1**, powered by
[TypeSafe Jev](https://docs.typesafe.ai). Instead of summarizing old turns, it
scores every tool call and tool result with Jev and removes or truncates only
the stale ones. Everything that stays is kept word for word.

This is the OpenCode **v1** counterpart of

(MIT). That project targets Claude Code; the other community ports target
OpenCode V2's `context` hook. OpenCode v1 does not have that hook, so this port
uses `experimental.chat.messages.transform` instead.

## How it works

```
outgoing request -> map OpenCode tool parts to the library message model
                 -> ask Jev two noul questions per candidate tool call
                    (keep the call? keep the result?)
                 -> drop_call / drop_result / keep
                 -> rewrite only the outgoing request
```

A candidate is a tool call that is not pinned (first message / newest
`preserveRecentMessages`), whose result is at least `minResultChars`, and whose
tool is not in `protectTools`.

- **Non-destructive:** persisted history, the UI, and stored sessions are never
  modified. Only the request sent to the model is changed. (OpenCode also runs
  this hook on the request that _builds_ a `/compact` summary, so that request is
  pruned too; the stored transcript still is not.)
- **Verbatim:** user and assistant text is never rewritten. Only tool calls and
  tool outputs are dropped or truncated.
- **Fail-open:** a missing key, timeout, transport error, bad answer, or any
  other failure leaves the request untouched.
- **Cached:** decisions are cached per tool call id, so the same call is not
  re-scored on every request (`rejudgeAfterMs`).
- **Pinned:** the first message and the newest `preserveRecentMessages` messages
  are never touched.

## Install

### Option A - one command (recommended)

OpenCode fetches the plugin and its dependency for you. Add it to
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git"]
}
```

Or let the CLI edit the global config for you (`-g`; without it the CLI writes
the project-local config):

```sh
opencode plugin fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git -g
```

### Option B - local file

OpenCode v1 loads only top-level `*.ts` / `*.js` files in the global plugin
directory (`~/.config/opencode/plugin/` or `~/.config/opencode/plugins/`); it
does **not** recurse into subfolders. Install the dependency at the config root,
then drop the plugin file in place:

```sh
cd ~/.config/opencode

curl -fsSL -o plugins/fast-jev.ts \
  https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/plugins/fast-jev.ts
```

### Finish setup

1. Add the plugin config file:

   ```sh
   cd ~/.config/opencode
   curl -fsSL -o fast-jev.json \
     https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/fast-jev.example.json
   ```

2. Add your Jev key - see [TypeSafe API key](#typesafe-api-key).

3. Restart OpenCode. It starts in `dryRun` mode, so nothing is pruned until you
   set `"dryRun": false` in `fast-jev.json`.

## TypeSafe API key

The plugin needs a Jev key. Create one in the TypeSafe console at
<https://console.typesafe.ai>, then give it to the plugin.

`apiKeyEnv` (default `TYPESAFE_API_KEY`) is the environment-variable **name** the
plugin looks up. The key is resolved in this order, first hit wins:

1. `apiKey` in `~/.config/opencode/fast-jev.json` (inline; not recommended)
2. the `TYPESAFE_API_KEY` environment variable of the **OpenCode server process**
3. a `TYPESAFE_API_KEY=...` line in `~/.config/opencode/.env` (easiest)
4. the contents of the file named by `apiKeyFile`

### Option 1 - the `.env` file (recommended)

`~/.config/opencode/.env` is read on every request, so `fast-jev.json` never has
to hold a secret. Create the file (or append a line):

```sh
printf 'TYPESAFE_API_KEY=your-key-here\n' >> ~/.config/opencode/.env
```

Keep `.env` out of version control.

### Option 2 - the server environment

Set the variable before starting OpenCode:

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

Only if you cannot use an environment variable. Add the key to
`~/.config/opencode/fast-jev.json`:

```json
{ "apiKey": "your-key-here" }
```

### Using another provider

Set `provider` in `fast-jev.json` to `zen` or `openrouter` and supply that
provider's key instead (`OPENCODE_API_KEY` or `OPENROUTER_API_KEY`). For anything
else, use `provider: "custom"` with `baseUrl`, `model`, and `apiKeyEnv`.

Without a valid key the plugin fails open: it logs a warning and sends the
request unchanged.

## Configure

`~/.config/opencode/fast-jev.json` is re-read on every request, so edits apply
without a restart. The shipped example is observe-only (`dryRun: true`).

| Option                   | Default    | Meaning                                                      |
| ------------------------ | ---------- | ------------------------------------------------------------ |
| `enabled`                | `true`     | Master switch                                                |
| `dryRun`                 | `true`     | Score and log, but do not rewrite the request                |
| `provider`               | `typesafe` | `typesafe`, `zen`, `openrouter`, or `custom`                 |
| `baseUrl`                | preset     | System One endpoint (required for `custom`)                  |
| `model`                  | preset     | Jev model id                                                 |
| `apiKey`                 | `""`       | Inline key (prefer `apiKeyEnv`)                              |
| `apiKeyEnv`              | preset     | Environment variable holding the key                         |
| `apiKeyFile`             | `""`       | File containing the key                                      |
| `keepThreshold`          | `0.5`      | Minimum probability for a call or result to stay             |
| `preserveRecentMessages` | `6`        | Newest messages never judged                                 |
| `maxStateTokens`         | `25000`    | State token ceiling                                          |
| `maxRequestTokens`       | `30000`    | State plus one batch of questions                            |
| `truncateHeadChars`      | `300`      | Head kept when a result is truncated                         |
| `minResultChars`         | `2000`     | Results below this are never candidates                      |
| `protectTools`           | `[]`       | Tool names whose calls/results are always kept               |
| `rejudgeAfterMs`         | `600000`   | Re-score a call after this long; `0` re-scores every request |
| `timeoutMs`              | `30000`    | Per-request deadline; a stalled endpoint fails open          |
| `log`                    | `true`     | Structured logging via the OpenCode client                   |

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
npm run bench          # parity against the upstream Claude Code engine
npm run bench:savings  # token savings, with and without Jev
```

### Parity with the Claude Code port

`bench/benchmark.mjs` feeds an identical transcript to the upstream engine

identical set of Jev answers:

```
transcript: 31 messages, 24 tool calls, 98478 chars
parity      actions identical: true (24/24)
            chars after identical: true
            message count identical: true
cache       second request: 0 jev request(s)
overhead    no eligible calls: 1 ms (mapping only, no Jev call)
```

Same decisions and same reduction as the Claude Code port; the adapter adds
milliseconds.

### Token savings, with and without Jev

`bench/savings.mjs` replays a small realistic task - fix a failing `/login` test -
and measures the tokens in the outgoing request before and after pruning.

```
transcript     14 messages, 6 tool calls
without Jev    1358 tokens

with Jev, by keepThreshold:
  threshold   tokens   saved     actions
  0.50           71    - 94.8%   keep=0 drop_result=0 drop_call=6
  0.30          476    - 64.9%   keep=2 drop_result=1 drop_call=3
  0.15          891    - 34.4%   keep=4 drop_result=2 drop_call=0
```

Example run against the live TypeSafe endpoint. Three threshold passes cost **one**
Jev request: decisions are cached and re-decided locally when the threshold
changes.

Note that `keepThreshold` trades savings against recall. At the upstream default
of `0.5` this transcript loses everything, including the edit and the passing test
run; at `0.15` every call is kept and only two bulky results are truncated. Tune
it against your own traffic, starting low.

Tokens are estimated with the same estimator the plugin uses to plan requests,
not provider-billed tokens.

## Test

Offline; no network and no key. The harness starts a local mock System One
endpoint and drives the plugin's hook end to end. Requires Node >= 22.6 (the
test runner uses `--experimental-strip-types`).

```sh
npm test
npm run format:check
```

## Compatibility

Built and verified against OpenCode **1.18.32** (`experimental.chat.messages.transform`).
OpenCode V2 uses a different plugin API and is not supported by this port.

## Credits


- Decisions: [TypeSafe Jev](https://docs.typesafe.ai)

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the upstream license notice.

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with TypeSafe or OpenCode.
