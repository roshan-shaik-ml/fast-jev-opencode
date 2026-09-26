# fast-jev-opencode

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
                 -> ask Jev two noul questions per non-pinned tool call
                    (keep the call? keep the result?)
                 -> drop_call / drop_result / keep
                 -> rewrite only the outgoing request
```

- **Non-destructive:** persisted history, the UI, and `/compact` are never
  modified. Only the request sent to the model is changed.
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
  "plugin": [
    "fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git"
  ]
}
```

Or let the CLI edit the config for you:

```sh
opencode plugin fast-jev-opencode@git+https://github.com/roshan-shaik-ml/fast-jev-opencode.git
```

### Option B - local file

OpenCode v1 loads only top-level `*.ts` / `*.js` files in
`~/.config/opencode/plugins/`; it does **not** recurse into subfolders. Install
the dependency at the config root, then drop the plugin file in place:

```sh
cd ~/.config/opencode

curl -fsSL -o plugins/fast-jev.ts \
  https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/plugins/fast-jev.ts
```

### Configure and restart

```sh
cd ~/.config/opencode
curl -fsSL -o fast-jev.json \
  https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/fast-jev.example.json
echo 'TYPESAFE_API_KEY=...' >> .env
```

Then restart OpenCode. It starts in `dryRun` mode, so nothing is pruned until
you set `"dryRun": false` in `fast-jev.json`. Without a key the plugin stands
down and logs a warning.

## Configure

`~/.config/opencode/fast-jev.json` is re-read on every request, so edits apply
without a restart. The shipped example is observe-only (`dryRun: true`).

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `dryRun` | `true` | Score and log, but do not rewrite the request |
| `provider` | `typesafe` | `typesafe`, `zen`, `openrouter`, or `custom` |
| `baseUrl` | preset | System One endpoint (required for `custom`) |
| `model` | preset | Jev model id |
| `apiKey` | `""` | Inline key (prefer `apiKeyEnv`) |
| `apiKeyEnv` | preset | Environment variable holding the key |
| `apiKeyFile` | `""` | File containing the key |
| `keepThreshold` | `0.5` | Minimum probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never judged |
| `maxStateTokens` | `25000` | State token ceiling |
| `maxRequestTokens` | `30000` | State plus one batch of questions |
| `truncateHeadChars` | `300` | Head kept when a result is truncated |
| `minResultChars` | `2000` | Results below this are never candidates |
| `protectTools` | `[]` | Tool names whose calls/results are always kept |
| `rejudgeAfterMs` | `600000` | Re-score a call after this long |
| `log` | `true` | Structured logging via the OpenCode client |

Provider presets:

| provider | endpoint | model | key |
| --- | --- | --- | --- |
| `typesafe` | `api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `zen` | `opencode.ai/zen/v1/systemone` | `jev-1.13-free` | `OPENCODE_API_KEY` |
| `openrouter` | `openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |
| `custom` | *required* | *required* | via `apiKey` / `apiKeyEnv` |

## Test

Offline; no network and no key. The harness starts a local mock System One
endpoint and drives the plugin's hook end to end.

```sh
npm test
```

## Compatibility

Built and verified against OpenCode **1.18.32** (`experimental.chat.messages.transform`).
OpenCode V2 uses a different plugin API and is not supported by this port.

## Credits


- Decisions: [TypeSafe Jev](https://docs.typesafe.ai)

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with TypeSafe or OpenCode.
