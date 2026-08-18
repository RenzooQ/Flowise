# End-to-end evidence — Agent Skills

Run date: **2026-08-18**. Flowise 3.1.4, base commit `9291856d`.

**Result: PASS.** Two cases, **21 assertions**, all green — re-run on branch
`fix/agent-skills-hardening` from the committed harness.

> Two corrections to an earlier version of this document, both found by re-running it rather than
> re-reading it. It claimed **17** assertions, which was the count before the harness grew; the
> harness emits 21. And the "Reproducing" section pointed at a scratch directory that was in no
> checkout, so the run was not reproducible by anyone. The harness is now committed — see
> [Reproducing](#reproducing). Re-running it also exposed a defect in the harness itself, where an
> assertion scanned for `##` headings while the responder reported `#{1,3}`; that is fixed and the
> two patterns are commented as needing to stay in step.

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

## Re-run against a REAL Claude model (2026-08-18)

Everything above used a deterministic stub, because no API key was available. That is no longer
the limitation it was: the same e2e was re-run end to end against a genuine Claude model, driven
through a purpose-built OpenAI-compatible bridge over the Claude Code CLI (no API key — it uses
the existing subscription login). **All assertions green.**

```
tools called: ["spec-driven-development"]          <- elected unprompted, from 24 tools
the answer echoes the loaded skill instructions    <- echoed: Tech Stack, Project Structure, Code Style
envelope intact, REFERENCE MATERIAL framing present, skill named
observation contains real vendored text ("## Overview")

targeted dispatch: attempt 1 of 3 -> ["test-driven-development"]
returned body matches the vendored SKILL.md byte-for-byte (15,970 chars)

RESULT: PASS
```

The second line is the one that matters, and it is a genuinely stronger claim than anything the
stub could support. The assertion no longer greps for the word "skill" — it pulls the multi-word
`##` headings out of whichever skill the agent actually loaded and requires the final answer to
echo one. The agent reproduced **three** of `spec-driven-development`’s own section names, having
asked first about payment processors, PCI-DSS scope and capability decomposition. That is what
"the agent followed the skill" looks like, rather than "the agent mentioned skills".

The named-skill case now runs up to **3 attempts and passes on ≥1**, which is the bar
`MASTER_PROMPT.md` sets for a nondeterministic e2e. It succeeded on the first attempt.

Two honest caveats. Tool calling through the bridge is **prompt-driven** — the model is asked to
emit JSON naming a tool, rather than using a provider-side function-calling API — so a malformed
reply degrades to a plain answer instead of a tool call. And each call takes 30–60 seconds,
because every request spawns a CLI process. Neither affects what is being proven here, but both
mean this is a development and test path, not a production one.

The bridge, its wiring instructions and its limits live outside this repository, in the parent
project at `tools/claude-bridge/`.

## Verified from a pristine clone

Everything above was measured in a working tree that had been built up incrementally, which cannot
prove another person could use this branch. So the whole CI sequence was repeated against a fresh
`git clone` of `feat/agent-skills` — a tree nothing in this project had ever touched:

```
git clone --branch feat/agent-skills --depth 1     fresh tree
pnpm install --frozen-lockfile      exit 0         3m56s
pnpm lint                           exit 0         7 problems (0 errors, 7 warnings)
pnpm build                          exit 0         6/6 turbo tasks

node, loaded from that clone dist/:
  tools exposed        24
  icon in dist         yes
  enveloped            true
  body byte-identical  true  (15,970 chars vs the vendored SKILL.md)
  loadMethods options  24
```

`--frozen-lockfile` is the meaningful one: it is what CI runs, and it fails outright if
`pnpm-lock.yaml` and the `package.json` files disagree. Passing it on a clean tree is the proof
that the hand-written three-line importer entry added for the `js-yaml` pin is genuinely correct,
rather than merely working in a tree that already had the package installed.

## Reproducing

The harness is committed at
[`packages/components/nodes/tools/AgentSkills/__e2e__/`](../packages/components/nodes/tools/AgentSkills/__e2e__/),
which is where it should have been from the start — the commands below originally pointed into a
scratch directory outside the repository, so nobody but the author could run them.

```bash
cd packages/components/nodes/tools/AgentSkills/__e2e__

# 1. build the components package so dist/ is current
pnpm --filter flowise-components build

# 2. start the stub (zero dependencies, node:http only)
node stubmodel/server.js 8756

# 3. run it
node run-e2e.js 8756
```

Every path resolves from the harness's own location, so this works from any clone on any host. Exit
status is `0` on pass and `1` on failure. Results land in `__e2e__/evidence.txt`, and the stub logs
every request it received to `__e2e__/stubmodel/requests.log` as an independent observer.

No credential store is required: `getCredentialParam` (`src/utils.ts:689-691`) reads
`nodeData.inputs[paramName]` before the credential data, so `openRouterApiKey: 'sk-dummy-e2e'` in
the node inputs is sufficient. `streaming: false` is required because the stub answers with a single
JSON body rather than SSE, and `ChatOpenRouter.ts:155` defaults streaming to `true`.
