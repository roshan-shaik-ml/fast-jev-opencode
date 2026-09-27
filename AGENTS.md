# AGENTS.md

Instructions for automated agents working in this repository.

## What this is

`fast-jev-opencode` — an OpenCode **v1 and v2** plugin that prunes stale tool calls and
truncates bulky tool results from the outgoing model request using TypeSafe Jev decisions.
Everything kept stays verbatim. Published on npm as `fast-jev-opencode`; also installable via
`opencode plugin add github:roshan-shaik-ml/fast-jev-opencode`.

## Layout

| Path            | What lives there                                                                      |
| --------------- | ------------------------------------------------------------------------------------- |
| `src/index.ts`  | Dual entrypoint: v2 `setup()` and v1 `server()` from one default export               |
| `src/v2.ts`     | v2 adapter: `ctx.session.hook("context")`, effort selection, opt-in compaction hook   |
| `src/v1.ts`     | v1 adapter: `experimental.chat.messages.transform`                                    |
| `src/shared.ts` | Config, planning, decision cache, log file, action application                        |
| `src/engine/`   | The engine: types, estimate, redact, state, decide, prefilter, questions, effort, ask |
| `test/`         | Offline suites driving the real entrypoints against a mock endpoint                   |
| `bench/`        | Consistency, savings, baseline, replay (real sessions), ab (live endpoint)            |

## Commands

Windows: use `npm.cmd`, not `npm` (a stray 0-byte `npm` shadows it on this machine).

| Command                | Expect                                                       |
| ---------------------- | ------------------------------------------------------------ |
| `npm test`             | Both suites print `ALL PASS`; offline, no key required       |
| `npm run bench`        | `actions identical: true (24/24)`, unchanged `chars` figures |
| `npm run format:check` | Clean; CI fails otherwise                                    |
| `npm run bench:replay` | Real sessions from OpenCode's SQLite store, read-only        |

## Rules that are not negotiable

- **Fail-open**: no code path may break or block a request. Every failure leaves the request
  untouched.
- **Requests only**: never touch persisted history, files, or the UI. The messages array handed
  to a hook is rewritten in memory and discarded.
- **Redact before egress**: everything sent for scoring passes `redactText` / `redactInput` —
  tool inputs and prose alike.
- **Tests are the spec**: `test/v2.test.mjs` fixtures mirror the payload captured from a live
  2.0.18 session. Never invent payload shapes.
- **Effort injection requires `compatibility.supportsEffortUpdates === true`** from the host. A
  wrong guess is not a no-op: an OpenAI-chat request fails outright on an unexpected content
  part.
- **No lifecycle scripts** in `package.json` — `npm install` must run no code.
- **Version sync**: `package.json`, `package-lock.json`, the git tag, the GitHub release, and
  npm must agree — see [RELEASING.md](./RELEASING.md).
- **The README is the npm page**: npm renders it from the published tarball, so a docs change
  reaches npm only with the next publish.
- Never publish, force-push, or open PRs to third-party repositories without the owner's
  explicit go-ahead.

## Next steps: distribution

1. **Official ecosystem listing — the highest-leverage action.**
   PR to `anomalyco/opencode`, file `packages/web/src/content/docs/ecosystem.mdx`, one row in
   the `## Plugins` table — and fill in their PR template or a bot closes it within 2 hours:

   ```
   | [fast-jev-opencode](https://github.com/roshan-shaik-ml/fast-jev-opencode) | Verbatim context pruning: stale tool calls dropped, bulky results truncated, everything kept word-for-word |
   ```

   Status: **drafted and ready, waiting on the owner's explicit go-ahead** (third-party repo).

2. **OpenDock** (`opendock.net`) — automated directory and leaderboard that crawls npm daily for
   packages tagged `opencode-plugin`. That keyword is present in `package.json`, so the page
   appears on the next crawl. No PR, no action.

3. **awesome-opencode** (`github.com/awesome-opencode/awesome-opencode`) — curated list linked
   from the official page. Same one-row PR as (1), same go-ahead condition. Note it already
   lists a plugin in this problem space, so lead with the guarantees: verbatim, fail-open,
   redaction, measured numbers.

4. **npm search** — nothing to fix. New packages take hours to roughly a day to enter the index;
   verify with `npmjs.com/search?q=fast-jev-opencode`. Do not attempt to inflate download
   counts; it is metric manipulation and npm acts on it.

5. **Publish 0.4.3** — packed and verified (`fast-jev-opencode-0.4.3.tgz`), carrying the
   rewritten README. Waiting on the owner's 2FA:

   ```powershell
   npm.cmd publish fast-jev-opencode-0.4.3.tgz
   ```

## Open owner actions

- Publish 0.4.3 (2FA) so the npm page shows the new README.
- Restart OpenCode to load the current build in interactive sessions.
- Rotate the `~/.config/opencode/service.json` password — it was exposed once in a chat log.
