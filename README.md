# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xhanzbrow/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xhanzbrow/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01)
"Build a GitHub-compatible git forge". No dependencies, no git binary, no
outside service — just the TypeScript standard library (`node:http`,
`node:zlib`, `node:crypto`) and its own in-memory store.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` boot probe |
| `GET /api/v3/` | GitHub REST v3 API root |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4 (subset + introspection) |
| `POST /mcp` | Model Context Protocol over Streamable HTTP: `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (v0 + v2), `git-upload-pack` (v2 fetch / ls-refs), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Deterministic by design: timestamps and request ids come from counters seeded
at a fixed epoch, issue/PR numbering is per-repo sequential, global ids are
stable base64 encodings, and fixture commits are stored verbatim — two runs on
the same instance leave identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the trial env origin; the entry binds an
ephemeral port, registers it, polls `/done`, and exits 0. `MAKEFUN_SHOP_TOKEN`
is the bearer token every API call presents (`/healthz` takes none).

## Layout

- `main.ts` — env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — HTTP server wiring.
- `src/store.ts` — in-memory store: repos, git objects, branches, issues, pulls, merges.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL v4 subset.
- `src/mcp.ts` — MCP over Streamable HTTP.
- `src/git.ts` — git smart HTTP: pkt-line framing, sideband, pack read/write (v2, plain objects), protocol v2 ls-refs/fetch, v0 receive-pack.
- `src/util.ts` — JSON replies, auth, deterministic time and request ids, pagination.

## Local verification

Against the bounty kit's local runner (`sdk/run.ts`):

- Conformance: **120/120 checks passed** (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5).
- Perf: **140/200** (push 39, clone 26, read 36, write 39) — total **940/1000**.

## License

MIT — see [LICENSE](LICENSE).
