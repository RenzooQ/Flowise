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
    `shipping-and-launch` says "production" three times.

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

The answer key is held separately from the prompt file so the run can be repeated blind. Scoring is
plain arithmetic over the two files; no model is involved in grading.
