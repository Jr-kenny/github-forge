# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jr-kenny/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Jr-kenny/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, built for
[make.fun github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
No UI, no outside service, no git binary: one process serves git smart HTTP,
REST v3, GraphQL v4 and MCP from its own in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later. Nothing to install: the program imports `node:http`,
`node:crypto`, `node:zlib` and its own modules only.

The process binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` answers
`{"done": true}`, then exits 0. See `main.ts` for the lifecycle.

## Surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, node lookup, introspection, batched operations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, server/discover, tools/list, tools/call |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`, except
`/healthz`. State is deterministic: timestamps come from a fixed epoch plus a
counter, never from the wall clock, so two runs over the same requests leave
the same state.

## Layout

- `main.ts`: the entry lifecycle. Bind, register, wait for done, exit 0.
- `app.ts`: the server: git, REST, GraphQL and MCP.
- `git.ts`: pkt-line framing, packfiles, reachability, shallow and delta handling.
- `store.ts`: the in-memory store: repos, objects, refs, issues, pull requests.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Local grading

The kit's runner grades the same suite the trial runs:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]
```

Local result on the practice instance: 120/120 checks, feature 600, agent 200,
perf 136, total 936.

---

<sub>Entered on [make.fun](https://make.fun/?ref=d40g50pd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
