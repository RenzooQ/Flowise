# Agent Skills — end-to-end harness

The unit tests (`../*.test.ts`) prove each piece in isolation. This harness proves the pieces work
_together_, driven through **real Flowise node classes loaded from the built tree** (`dist/`):

```
ChatOpenRouter  ──▶  ToolAgent (AgentExecutor)  ◀──  AgentSkills (24 tools)
                              │
                              ▼
                    local OpenAI-compatible endpoint
```

Loading from `dist/` is the point. `pnpm build` runs `tsc && gulp`, and `gulpfile.ts` copies only
`nodes/**/*.{jpg,png,svg}` — Markdown never reaches `dist/`. A green build therefore proves nothing
about skill delivery; this harness is what proves it, by resolving the vendored library from a built
tree through the `__dirname` probe in `registry.ts`.

## Running it

Everything resolves from this file's own location, so any checkout on any host works.

```bash
# 1. build the components package so dist/ is current
pnpm --filter flowise-components build

# 2. start the stub endpoint (zero dependencies, node:http only)
node stubmodel/server.js 8791

# 3. run the harness against it
node run-e2e.js 8791
```

Exit status is `0` on pass and `1` on failure, so this is usable as a CI gate. Results are written
to `evidence.txt`; the stub independently logs every request it received to `stubmodel/requests.log`.

`preflight.js` is a smaller check of the model + agent half alone, using a throwaway tool. It is
useful when the harness fails and you need to know whether the Agent Skills node is implicated.

## The endpoint, and what it can and cannot prove

`stubmodel/server.js` is a **deterministic** OpenAI-compatible endpoint. It selects a tool by lexical
overlap between the prompt and each tool's name and description — not by model judgement.

**Proven here:** Flowise serialises all 24 skills as tool definitions carrying their frontmatter
descriptions verbatim; the agent dispatches a chosen skill tool through the normal `AgentExecutor`
path; the node returns the skill body inside the untrusted-data envelope; the envelope survives the
round trip and re-enters the model context; the returned body is the vendored file byte-for-byte.

**Not proven here:** that a production LLM _elects_ to call a skill unprompted. That claim needs a
real model, and is addressed separately in [`docs/SKILL-SELECTION-EVAL.md`](../../../../../../docs/SKILL-SELECTION-EVAL.md).

Because selection is lexical, the skill the stub picks for a given prompt is a property of the stub,
not of the node — do not read it as evidence about routing quality.

## Keeping the two halves in step

The stub extracts the first heading from the envelope body with `/^#{1,3}\s+(.+)$/m`
(`stubmodel/server.js`). The assertion in `run-e2e.js` that checks the answer echoed that text scans
with the same heading levels. They must stay aligned: scanning only `##` there caused a spurious
failure whenever the selected skill's first heading was its H1 title.

## Not run by jest

These are `.js` files outside any `__tests__` directory, so jest's `testRegex` does not match them,
and `allowJs` is off in `tsconfig.json`, so `tsc` neither compiles them nor emits them into `dist/`.
They are source-only tooling.
