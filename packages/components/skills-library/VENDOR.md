# Vendored: addyosmani/agent-skills

This directory is a **verbatim copy** of selected content from an upstream repository. It is read at
runtime by `packages/components/nodes/tools/AgentSkills/` and is never compiled, bundled or executed.

## Provenance

| | |
|---|---|
| Upstream repo | https://github.com/addyosmani/agent-skills |
| Commit | `df1edb2e05487d0aa6d93c747141e0aed1187f25` |
| Fetched | 2026-08-18 |
| License | MIT — "Copyright (c) 2025 Addy Osmani" |

The upstream `LICENSE` is reproduced byte-for-byte at `./LICENSE` in this directory.

## What was copied

**35 files**, taken from three roots of the upstream checkout:

| Source root | Files | Destination |
|---|---|---|
| `skills/` | 27 `.md` — 24 `SKILL.md` plus `idea-refine`'s three companions (`examples.md`, `frameworks.md`, `refinement-criteria.md`) | `./skills/` |
| `references/` | 7 `.md` checklists | `./references/` |
| `LICENSE` | 1 | `./LICENSE` |

`references/` is required, not optional: 11 skills link to it as `../../references/<file>.md`, and the
layout here preserves that arithmetic exactly (`skills-library/skills/<x>/SKILL.md` → `../../references/`
→ `skills-library/references/`).

`idea-refine`'s three companion files carry no frontmatter, so they have no `name` and no `description`
and cannot become tools. The registry opens only files named `SKILL.md`, so they are never read. They
are vendored so `idea-refine`'s relative links resolve for a human reading the tree.

## What was deliberately NOT copied

| Upstream path | Why not |
|---|---|
| `skills/idea-refine/scripts/idea-refine.sh` | The only executable artefact in the whole upstream skill set, and it is unlinked — the catalog records it with `"ref": null`, so omitting it breaks no link in any `SKILL.md`. A skill is text; a vendored tree that provably contains **zero** executables makes that auditable rather than merely promised. |
| `evals/`, `hooks/`, `commands/`, `agents/`, `scripts/`, `docs/`, `.claude-plugin/`, `.codex-plugin/`, `plugin.json`, `.opencode/skills` | Not skill content, and none of it is reachable by the node. `.opencode/skills` is a symlink that materialises on Windows as a 10-byte regular file. |

## Modifications

**None.** Every file in this directory is unmodified upstream content, so Apache-2.0 §4(b) ("mark
modified files") has nothing to mark here. Any future local edit **must** be recorded in this file.

Two mechanisms protect that fidelity:

- Root `.gitattributes` contains `packages/components/skills-library/** text eol=lf`, so a Windows
  working tree keeps the upstream LF blobs byte-identical and `git hash-object` comparisons against
  upstream stay meaningful.
- Root `.prettierignore` contains `packages/components/skills-library/**`. Without it the
  `.husky/pre-commit` hook (`pretty-quick --staged`) would silently reformat every Markdown file here —
  Prettier has no Markdown processor and rewrites the prose itself. That would mutate the exact
  instruction text the node serves to agents.

## Re-vendor procedure

1. `git clone https://github.com/addyosmani/agent-skills` and `git checkout <new-sha>`.
2. Copy the three roots above — `skills/**/*.md`, `references/*.md`, `LICENSE` — minus the one
   exclusion. Do not follow symlinks. Read and write as UTF-8: every skill contains non-ASCII
   (em-dashes, box-drawing `┌─┐│└┘├┤`, arrows `→←▼▲`, `✓✗`, `≤≥≠±`).
3. Assert the counts: 24 `SKILL.md`, 35 `.md` total including this file, and **zero** files matching
   `*.sh`, `*.js`, `*.ps1`, `*.bat`, `*.cmd`.
4. Update the commit SHA and fetch date in the table above.
5. Run `pnpm lint` and check the staged diff (`git add …; pnpm quick; git diff --cached --stat`) to
   confirm nothing reformatted the vendored content.
