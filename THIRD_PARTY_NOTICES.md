# Third-party notices

## Prior art

This project implements **verbatim context pruning guided by Jev decisions** — the idea,
and the shape of the problem, come from earlier work in this space. No code from those
projects is copied, vendored, or depended on; the engine under `src/engine/` is our own
implementation.

We credit them because the approach is theirs to have invented, and because their
published measurements are what made the approach worth implementing:


  the original Claude Code implementation of the idea, MIT licensed.

  documents as its distribution. It is worth knowing that this package publishes **no
  `repository` field** and its publisher identity differs from the GitHub account the
  project credits. We do not consume it; an earlier revision of this project did, and that
  missing provenance link is a large part of why the engine is now ours.
- [TypeSafe Jev](https://docs.typesafe.ai) — the decision model the whole approach rests on.

## Dependencies

Runtime: `@opencode/plugin` (v2 entrypoint) only. The v1 entrypoint imports
`@opencode-ai/plugin` for types, erased at runtime.

There is no third-party compaction engine. `src/engine/` is ours.
