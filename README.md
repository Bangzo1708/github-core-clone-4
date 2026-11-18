# github-core-clone-4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Bangzo1708/github-core-clone-4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Bangzo1708/github-core-clone-4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process, written in erasable TypeScript with the standard library only. It serves git smart HTTP (protocol v2 and v0), the REST v3 API, GraphQL, and MCP over a single in-memory store, so a repository created over any surface is visible on all of them.

## Run it

```sh
PORT=18080 MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dkj7ja9h&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`.
- `app.ts` — HTTP routing, auth, body handling.
- `store.ts` — repositories, git objects, issues, pull requests, labels,
  comments; deterministic ids and timestamps.
- `gitwire.ts` — pkt-line framing, pack read/write, protocol v2/v0 handlers.
- `rest.ts` — the REST v3 API.
- `graphql.ts` — a hand-rolled GraphQL parser and executor.
- `mcp.ts` — MCP (Streamable HTTP) tools.
- `respond.ts` — shared response helpers.

## Performance notes

The hot paths are cached: issue/repository/pull-request JSON is serialized
once and reused until the object changes; git advertisements, ls-refs
replies and fetch replies are cached per repository and cleared on any ref
change; packs are plain objects with `deflateSync` at level 1. Timestamps
are sequence-based, never wall-clock, so repeated runs leave identical
state.

In the trial the environment sets `MAKEFUN_ENV_URL`; the server then binds an
ephemeral port, registers it, and exits when the trial polls `/done`.
