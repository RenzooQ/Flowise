# Skill-selection evaluation — do the shipped descriptions actually route correctly?

Run 2026-08-18 against branch `feat/agent-skills`.

`E2E-EVIDENCE.md` proves the _mechanism_: 24 tools transmitted, dispatch, envelope, real skill text
returned. It explicitly does **not** prove that a model picks the _right_ skill, because the e2e uses
a deterministic stub. This document closes that gap.

**Result: 95.7% top-1, 100% top-2.**

## Method

-   **Ground truth is upstream's own fixtures.** `evals/cases/*.json` in `addyosmani/agent-skills` ship
    labelled prompts per skill: `trigger.positive[]` (this skill should win) and `trigger.negative[]`
    with an explicit `owner` (a _different_ named skill should win). That yields **117 labelled prompts
    covering all 24 skills** — 78 positive, 39 negative-owner. Zero labels point at a non-existent skill.
-   **The tool list is the real one.** The 24 `{name, description}` pairs were captured from the BUILT
    node (`dist/nodes/tools/AgentSkills/AgentSkills.js`) by calling `init()`, not transcribed. 6,505
    characters of description in total.
-   **The selectors were blind.** Ten independent LLM agents each received a slice of the prompts plus
    the 24 descriptions, and were asked which single tool they would call, or `NONE`. The answer key was
    moved to a separate directory and the prompt file stripped of every label before the run; a leak
    check confirmed the string `expected` does not appear in what they read.
-   Each selector also returned a runner-up and a confidence rating.

## Results

```
scored 117 / 117
  top-1 accuracy : 112/117   95.7%
  top-2 accuracy : 117/117  100.0%
  answered NONE  : 2

by prompt type
  positive         n=78    top1 100.0%   top2 100.0%
  negative-owner   n=39    top1  87.2%   top2 100.0%

confidence vs correctness
  high    n=103   100.0% correct
  medium  n= 13    69.2%
  low     n=  1     0.0%

never chosen: 0 of 24
```

Three things worth drawing out:

1. **Every one of the 78 positive prompts routed correctly on first choice.**
2. **The correct skill was in the top 2 for all 117 prompts.** There is no prompt in the set the
   descriptions cannot reach.
3. **Confidence is well calibrated.** All 103 high-confidence answers were correct; all five misses
   came from the 14 medium/low ones. An agent's uncertainty here is a usable signal.

The 39 negative-owner prompts are the hard set by construction — upstream wrote them to _look_ like
they belong to another skill. 87% first-choice on adversarial cases is a good number.

## Validity check 2: does this predict a REAL Flowise agent?

The stronger objection to the headline number is not name matching, it is _methodology_: blind
selectors reasoning over a description list are not the same thing as a real agent holding 24
`StructuredTool` instances, bound to a real model through LangChain’s tool-calling path. If the two
diverge, 95.7% is misleading.

So a stratified sample of the same labelled prompts was run through the **real chain**
(`ChatOpenRouter` → `ToolAgent` → `AgentSkills`, from `dist/`) against a live Claude model. The
sample was deliberately stacked against the method: **every one of the five prompts the blind eval
got wrong**, plus twelve it got right.

```
scored                          16 of 17   (one case errored in the harness)
blind vs real agreement         15/16   93.8%

where the blind eval was RIGHT  11/11  still right in the real path
where the blind eval was WRONG   1/5   recovered by the real path

the single disagreement:  expected shipping-and-launch
                          blind NONE  ->  real shipping-and-launch   (real path did BETTER)
```

**Every case the blind method got right, the real agent also got right — 11 of 11.** The one
divergence went in the favourable direction. The blind methodology is therefore a faithful and
slightly _conservative_ predictor of production behaviour, and 95.7% stands as published.

The run also confirms the routing gaps below are genuine production behaviour rather than artifacts
of blind selection: the `ci-cd-and-automation` → `debugging-and-error-recovery` misroute reproduced
exactly, three times out of three, in a live agent.

⚠️ **Do not compare the 12/16 (75%) raw hit rate of this sample to the 95.7% headline.** This sample
is 5/17 known-bad by construction; it was chosen to stress the method, not to measure accuracy. The
meaningful figures here are the agreement rate and the 11/11.

## Validity check: is this just name matching?

A fair objection to the headline number: many fixture prompts contain words from the target skill's
own _name_, so a selector could score well by string overlap rather than by understanding the
description. Splitting the 117 prompts on whether any distinctive word of the expected skill's name
appears in the prompt text:

```
name-echo present    n= 43    top1  97.7%    top2 100.0%
NO name echo         n= 74    top1  94.6%    top2 100.0%
```

**The majority of the set (74 of 117) contains no name echo at all, and still scores 94.6% top-1.**
Those prompts are decided by the description text alone, so the result is not an artifact of name
matching. All four misses in that group are negative-owner (adversarial) cases at medium or low
confidence — three are the ci-cd/debugging collision, one is the staging gap.

## The five misses

| Prompt                                        | Expected                  | Chosen                         |
| --------------------------------------------- | ------------------------- | ------------------------------ |
| 3x "existing pipeline / build went red"       | `ci-cd-and-automation`    | `debugging-and-error-recovery` |
| "Run the full test suite and report failures" | `test-driven-development` | `NONE`                         |
| "Deploy the current build to staging"         | `shipping-and-launch`     | `NONE`                         |

All three failure modes are **gaps in the upstream descriptions**, not defects in this node:

-   **Nobody owns a red pipeline.** `debugging` says "Use when tests fail, builds break" but never says
    "CI"; `ci-cd` describes _authoring_ pipelines and never disclaims diagnosis.
-   **Nobody owns running an existing suite.** `test-driven-development` is entirely about _writing_
    tests.
-   **No description in the pack names a non-production environment** — staging, preview, canary.
    `shipping-and-launch` says "production" twice ("Prepares production launches. Use when preparing
    to deploy to production."), and nothing anywhere names another environment.

Other coverage gaps the analysis surfaced: the tokens _memory leak_, _feature flag_, and _PRD_ appear
in zero descriptions, and `documentation-and-adrs` covers creating docs but never updating them.

## Structural finding: runner-up magnets

All 24 descriptions win at least three prompts, so there is no literal dead weight. But two shapes
emerged:

-   **Precise** — `browser-testing-with-devtools`, `deprecation-and-migration`,
    `source-driven-development` win their own topic and are runner-up **zero** times across 117
    prompts. They exert no false gravity. This is the shape to copy.
-   **Runner-up magnets** — `code-review-and-quality` wins 3 (all containing the word "review") but is
    runner-up **15** times. `ci-cd-and-automation`: 3 wins, 8 runner-ups. They compete everywhere and
    discriminate nowhere.

The structural cause is four descriptions claiming universal scope: `"Use before merging any change"`,
`"Use when making any code change"`, `"Use when implementing any logic, fixing any bug, or changing
any behavior"`, `"Use when implementing any feature or change that touches more than one file"`.

The sharpest overlap is a near-duplicated sentence: `planning-and-task-breakdown` says "Use when a
task feels too large to start" and `incremental-implementation` says "when a task feels too big to
land in one step."

## Recommendation: do NOT patch the vendored descriptions here

Every description is line 3 of a `SKILL.md` frontmatter block, vendored **byte-for-byte** from
upstream at `df1edb2e`. Editing them in this fork would:

-   break the byte-fidelity guarantee asserted in `NOTICE` and `skills-library/VENDOR.md`,
-   make the "unmodified upstream content" claim false, taking Apache-2.0 §4(b) from _nothing to mark_
    to _something to mark_, and
-   conflict on exactly the edited line at every future upstream pull.

Two clean paths instead:

1. **Upstream the wording** as a PR to `addyosmani/agent-skills`, so the delta disappears.
2. **Add a description-override map to the node**, applied when the tool manifest is built. The node
   already parses frontmatter, so this is a lookup rather than a content fork, and the vendored
   Markdown stays pristine. Not implemented — recorded as the natural next feature.

## Reproducing

Be clear about which half of this is replayable, because the two are not the same.

**The inputs are fully reproducible.** Both the labelled prompts and the tool descriptions can be
rebuilt from source with a committed script:

```bash
git clone https://github.com/addyosmani/agent-skills
git -C agent-skills checkout df1edb2e05487d0aa6d93c747141e0aed1187f25   # the SHA in VENDOR.md

pnpm --filter flowise-components build
cd packages/components/nodes/tools/AgentSkills/__e2e__
node build-selection-dataset.js --skills-repo ../../../../../../agent-skills
```

It extracts the labelled prompts from upstream's `evals/cases/*.json` and reads the 24
`{name, description}` pairs out of the **built** node by calling `init()` — not transcribed by hand,
which matters when the descriptions are the entire selection surface. It then checks its own output
against the totals published above and exits non-zero on any drift. Verified to reproduce them
exactly:

```
skills            : 24
labelled prompts  : 117  (78 positive, 39 negative-owner)
description chars : 6505
dangling labels   : 0
Counts match the published evaluation.
```

**The scoring run is not replayable, and no wording here should suggest otherwise.** It used ten
independent LLM selectors, which are not deterministic; re-running would produce a similar number,
not the same one. The answer key was held separately from the prompt file so the selectors ran
blind, and grading itself is plain arithmetic with no model involved — but the measurement is a
point-in-time result, not a regression test. Treat 95.7% as a measured observation about these
descriptions, reproducible in method rather than in digits.

What a reader can independently verify today: the dataset (above), the byte-fidelity of every
description (`vendored-library.test.ts`), and the mechanism end to end
([`E2E-EVIDENCE.md`](E2E-EVIDENCE.md)).
