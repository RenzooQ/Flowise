# End-to-end evidence — Agent Skills

Run date: **2026-08-18**. Branch `feat/agent-skills`, Flowise 3.1.4, base commit `9291856d`.

**Result: PASS.** Two cases, 17 assertions, all green.

---

## What was actually exercised

Three **real Flowise node classes**, required out of the **built** tree
(`packages/components/dist/nodes/...`), not the TypeScript sources:

```
ChatOpenRouter ──▶ ToolAgent (AgentExecutor) ◀── AgentSkills (24 tools)
                          │
                          ▼
                 local OpenAI-compatible model endpoint
```

Loading from `dist/` is deliberate. `pnpm build` runs `tsc && gulp`, and `gulpfile.ts` copies only
`nodes/**/*.{jpg,png,svg}` — Markdown never reaches `dist/`. So a green build proves nothing about
skill delivery. This run is the proof: 24 tools carrying real vendored Markdown, resolved from a
built tree via the `__dirname` probe.

## The model endpoint, and why it is not a hosted LLM

No LLM API key exists on this machine. The prescribed path in `MASTER_PROMPT.md:170` —
`ChatOpenAICustom` pointed at a localhost bridge — **cannot work**: `ChatOpenAICustom.ts:164` calls
`checkDenyList(basePath)`, and the default deny list (`src/httpSecurity.ts:8-27`) blocks `localhost`,
`::1`, `127.0.0.0/8` and the private ranges. The node throws
`Access to this host is denied by policy.` at init. `ChatOpenRouter` was used instead: it is
OpenAI-wire-protocol, `BaseChatModel`, bindTools-capable, and has **zero** `checkDenyList` calls.

Two Claude-subscription bridges were evaluated and both rejected:

| Bridge                                      | Outcome                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-max-api-proxy` (npm, `atalovesyou`) | **Zero** occurrences of `tool_calls` in its entire `dist/`. Text completions only.                                                                                                                                                                                                                                                         |
| `wende/claude-max-api-proxy` (GitHub)       | Builds and runs, but **ignores caller-supplied `tools`**. Measured: it answered with the Claude Code CLI's _own_ tools (DesignSync, CronCreate, Monitor…), `finish_reason: "stop"`, `prompt_tokens: 4`, and silently served `claude-haiku-4` for a `claude-sonnet-5` request. It wraps the Claude _agent_, which carries a fixed tool set. |

The endpoint is therefore a **purpose-built deterministic OpenAI-compatible stub** (zero
dependencies, `node:http` only) that implements `/v1/models` and `/v1/chat/completions` with genuine
`tool_calls` / `finish_reason: "tool_calls"` semantics, and logs every request as an independent
observer.

## ⚠️ What this proves, and what it does not

**Proven:**

1. Flowise serialises all **24** skills as tool definitions and transmits them to the model — the
   stub's independent log records `tool_count=24`.
2. Each tool carries its **frontmatter description verbatim** as the selection surface.
3. The agent dispatches a chosen skill tool through the normal `AgentExecutor` path.
4. The `AgentSkills` node returns the skill body wrapped in the untrusted-data envelope.
5. The envelope survives the round trip intact and re-enters the model context — the stub's second
   turn reports `enveloped=true`.
6. The body is the **real vendored file**, byte-for-byte.

**NOT proven:** that a production LLM _elects_ to call a skill unprompted. Selection in the stub is
deterministic lexical overlap, not model judgement. Case 1 makes this visible rather than hiding it:
for a _"write a formal specification"_ prompt the stub chose `code-review-and-quality` with a score
of 2, tied with three other skills. The mechanism is proven here; the judgement is not.

**That gap is now closed separately.** See [SKILL-SELECTION-EVAL.md](./SKILL-SELECTION-EVAL.md): the
24 shipped descriptions were blind-tested by real LLM selectors against 117 labelled prompts from
upstream own eval fixtures, scoring **95.7% top-1 and 100% top-2**, with all 78 positive prompts
routed correctly on first choice. This document covers the plumbing; that one covers the judgement.

---

## Case 1 — an agent loads a skill unprompted

Prompt: _"I need to write a formal specification for a billing system before any implementation
starts."_

```
[PASS] category is Tools
[PASS] baseClasses contains literal 'Tool'        ["AgentSkills","Tool"]
[PASS] author is omitted (node would be hidden otherwise)
[PASS] init() returns an array
[PASS] exposes 24 tools
[PASS] tool names are unique
[PASS] tool names are lowercase-safe
[PASS] model constructed (localhost basepath, no deny-list throw)
[PASS] model exposes bindTools()
[PASS] AgentExecutor built
[PASS] the agent called at least one tool          ["code-review-and-quality"]
[PASS] the tool it called is one of the 24 skills
[PASS] a skill returned the untrusted-data envelope
[PASS] the envelope carries the REFERENCE MATERIAL framing
[PASS] the envelope names the skill
[PASS] observation contains real vendored text ("## Overview")
[PASS] final answer reflects the skill content
```

Agent output:

```
I loaded the "code-review-and-quality" skill and will follow it.
Envelope intact: true. Skill text length: 20226 characters.
First heading in the skill body: "Code Review and Quality".
```

## Case 2 — a _specific_ skill is individually addressable

Prompt: _"Please load the test-driven-development skill and follow it."_

```
[PASS] dispatched exactly "test-driven-development"
[PASS] its envelope names that same skill
[PASS] returned body matches the vendored SKILL.md body byte-for-byte
       returned 15970 chars vs file 15970
```

The byte-for-byte match is the strongest assertion in the run. It shows each of the 24 tools returns
**its own file's text** — not a shared body, not a first-match, not a truncation.

---

## Independent corroboration from the stub's request log

```
initial      : tool_count=24
selection    : chosen=code-review-and-quality score=2
               runners_up=["doubt-driven-development:2","incremental-implementation:2","interview-me:2"]
after-result : roles=["system","user","assistant","tool"]
final        : enveloped=true skill=code-review-and-quality chars=20226
```

`roles` containing `tool` confirms the tool result re-entered the conversation. The tied scores are
the honest signal that stub selection is lexical, not semantic.

## Security gates (run separately, all green)

```
grep -n "executeJavaScriptCode|eval(|new Function|child_process|vm2|CustomTool/core|OpenAPIToolkit/core"
     packages/components/nodes/tools/AgentSkills/*.ts        -> no matches

find packages/components/skills-library -name '*.sh' -o -name '*.js' -o -name '*.ps1'
     -o -name '*.bat' -o -name '*.cmd' -o -name '*.exe'      -> empty

git diff --stat -- packages/components/skills-library        -> empty (vendored content unmutated)
```

## Reproducing

```bash
# 1. start the stub (zero dependencies)
node <scratch>/stubmodel/server.js 8756

# 2. build the components package so dist/ is current
pnpm --filter flowise-components build

# 3. run
node <scratch>/e2e/run-e2e.js 8756
```

No credential store is required: `getCredentialParam` (`src/utils.ts:689-691`) reads
`nodeData.inputs[paramName]` before the credential data, so `openRouterApiKey: 'sk-dummy-e2e'` in
the node inputs is sufficient. `streaming: false` is required because the stub answers with a single
JSON body rather than SSE, and `ChatOpenRouter.ts:155` defaults streaming to `true`.
