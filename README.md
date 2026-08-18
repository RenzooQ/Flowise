<!-- markdownlint-disable MD030 -->

<p align="center">
<img src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_white.svg#gh-light-mode-only">
<img src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_dark.svg#gh-dark-mode-only">
</p>

<div align="center">

[![Release Notes](https://img.shields.io/github/release/FlowiseAI/Flowise)](https://github.com/FlowiseAI/Flowise/releases)
[![Discord](https://img.shields.io/discord/1087698854775881778?label=Discord&logo=discord)](https://discord.gg/jbaHfsRVBW)
[![Twitter Follow](https://img.shields.io/twitter/follow/FlowiseAI?style=social)](https://twitter.com/FlowiseAI)
[![GitHub star chart](https://img.shields.io/github/stars/FlowiseAI/Flowise?style=social)](https://star-history.com/#FlowiseAI/Flowise)
[![GitHub fork](https://img.shields.io/github/forks/FlowiseAI/Flowise?style=social)](https://github.com/FlowiseAI/Flowise/fork)

English | [繁體中文](./i18n/README-TW.md) | [简体中文](./i18n/README-ZH.md) | [日本語](./i18n/README-JA.md) | [한국어](./i18n/README-KR.md)

</div>

<h2>Flowise has been archived. Refer to [Future of Flowise](https://github.com/FlowiseAI/Flowise/discussions/6727)</h2>

<h3>Build AI Agents, Visually</h3>
<a href="https://github.com/FlowiseAI/Flowise">
<img width="100%" src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_agentflow.gif?raw=true"></a>

## 📚 Table of Contents

-   [🧠 Agent Skills](#-agent-skills) ← added by this fork
-   [⚡ Quick Start](#-quick-start)
-   [🐳 Docker](#-docker)
-   [👨‍💻 Developers](#-developers)
-   [🌱 Env Variables](#-env-variables)
-   [📖 Documentation](#-documentation)
-   [🌐 Self Host](#-self-host)
-   [☁️ Flowise Cloud](#️-flowise-cloud)
-   [🙋 Support](#-support)
-   [🙌 Contributing](#-contributing)
-   [📄 License](#-license)

## 🧠 Agent Skills

This fork adds an **Agent Skills** node to the **Tools** category. It turns a directory of Markdown
skill files into callable tools, so an Agent can decide _for itself_ when a skill applies and load
its instructions on demand.

24 skills from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT) ship with
the fork, vendored at `packages/components/skills-library/`.

### How it works

Each selected skill becomes **one tool**, built from the skill file's YAML frontmatter. The
description is the whole selection mechanism: it is what the model matches against when deciding
whether the skill is relevant, which mirrors how these skills are designed to activate on context.

Because it carries that weight, the node passes it through with nothing prepended, appended or
reworded. Two transformations do apply, and both matter only for skills you write yourself:

-   **`description`** is used verbatim **up to 1024 characters** — upstream's own budget. A longer one
    is cut at the last word boundary and marked with an ellipsis, which can lose the tail of the
    "Use when …" clause the model routes on. The only signal is a server-log warning. Every bundled
    description is comfortably inside the budget.
-   **`name`** is sanitised into a tool name: lowercased, spaces to underscores, anything outside
    `[a-z0-9_-]` dropped, capped at 64 characters, de-duplicated with `_2`, `_3` on collision. All 24
    bundled names survive unchanged, so this is a no-op on the bundled library.

Calling the tool performs **progressive disclosure**: it returns that skill's instruction text for
the agent to follow. Nothing is executed. A skill is text, never code.

```
┌──────────────┐        ┌───────────────┐        ┌──────────────────────┐
│  Chat Model  │───────▶│  Tool Agent   │◀───────│  Agent Skills (Tools)│
└──────────────┘        └───────────────┘        └──────────────────────┘
                               │                            │
                               │  "write a spec for X"      │  24 tools, one per skill
                               ▼                            ▼
                     model picks a skill tool  ──▶  returns that SKILL.md's body
```

### Adding it to a flow

1. Drag **Tools → Agent Skills** onto the canvas.
2. Connect its output to an Agent node's **Tools** input (the classic _Tool Agent_, or the
   AgentFlow v2 _Agent_).
3. Leave **Skill Selection** on `All Skills` to expose all 24, or switch to `Selected Skills` and
   pick a subset from the dropdown.

### Inputs

| Input                | Type                             | What it does                                                                                                                                                            |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skill Selection**  | `All Skills` / `Selected Skills` | Expose every skill in the directory, or just the ones you pick. Defaults to all.                                                                                        |
| **Skills**           | multi-select                     | Shown when _Selected Skills_ is chosen. Lists every skill found in the directory. Refresh re-reads the list, but see the caching note below.                            |
| **Skills Directory** | string _(Additional Parameters)_ | Absolute path to a directory laid out as `<dir>/<skill-name>/SKILL.md`. Leave empty to use the 24 bundled skills. **See the trust boundary below before setting this.** |

UNC and device paths (`\\host\share`, `\\?\…`) are refused: the server would otherwise open an SMB
session to a host named by whoever edited the flow, authenticating as the Flowise service account.

#### Caching, and what refresh does

The **list** of skills is cached per directory for **60 seconds**. Within that window, Refresh
re-reads the cached list, so a skill folder you have just added, removed or renamed may not appear
for up to a minute. Pointing Skills Directory at a _different_ path is never stale — the cache is
keyed on the resolved path, so a new path is always a fresh scan.

Skill **bodies** are never cached. Editing the text inside an existing `SKILL.md` takes effect on
the very next tool call, with no wait.

### Writing your own skill

Create `<your-skills-dir>/<skill-name>/SKILL.md`. Only the frontmatter is required:

```markdown
---
name: my-custom-skill
description: What this skill does, and when to use it. The model reads this to decide whether to
    call the tool, so describe the trigger conditions concretely — e.g. "Use when the user asks to
    review a database migration."
---

# My Custom Skill

## Overview

Everything after the frontmatter is returned verbatim when the tool is called.
```

Rules the parser enforces:

-   `name` and `description` must both be non-empty strings. Anything else is skipped with a warning
    rather than crashing the node.
-   Keep `description` **within 1024 characters**. Beyond that it is truncated at a word boundary,
    which quietly costs you the end of the "Use when …" clause the model routes on.
-   The file must be named exactly `SKILL.md`, exactly one directory below the skills root. Nothing
    else is ever opened.
-   Section headings are optional. There is no required structure — the whole body after the
    frontmatter is what the tool returns by default.

Point **Skills Directory** at the parent directory, then hit refresh on the **Skills** input — noting
the 60-second window described above if you are adding a folder to a directory already in use.

### Loading part of a skill

The tool takes a `section` argument. It is **required** by the schema — OpenAI strict mode demands
that `required` list every property — so the model must always send it; passing an **empty string**
is the normal case and means "the whole skill". Pass a heading (for example `Verification`) to get
just that section instead. If the heading is absent, the full body is returned — a miss is normal,
not an error.

### Companion reference documents

11 of the 24 bundled skills tell the agent to consult a shared checklist — "see the quick-reference
table in `../../references/security-checklist.md`", and similar. Seven such files exist, and the
tool can return them.

The tool's second argument, `reference`, takes one of those filenames; empty string (the normal
case) means "the skill itself". **Each skill can only reach the companions its own text cites**,
and each tool's schema lists exactly those names, so the model is told what is legal rather than
left to guess. The other 13 skills advertise that they cite none.

This deliberately does not turn the node into a general file reader. The readable set is a closed
allowlist derived from vendored Markdown — not from the model, not from the flow author — and the
names are matched against `[a-z0-9-]+\.md`, so no separator or dot-segment can enter it. Companions
are served through exactly the same symlink, regular-file and size guards as a skill body, and
inside the same untrusted-data envelope.

### Section resolution

Resolution tries, in order: exact `##` match, exact `###` match, then a normalised prefix match at
each level, taking the first occurrence. That ordering is deliberate. In the bundled library
`test-driven-development` has both `## When to Use` and `## When to Use Subagents for Testing`, so
exact must beat prefix; `idea-refine` puts `### Process` at H3; and `security-and-hardening` writes
`## Process: Threat Model First`, which only a prefix match will find.

### Known routing gaps

The bundled descriptions were measured against 117 labelled prompts from the upstream project’s own
eval fixtures: **95.7% routed to the right skill on first choice, 100% within the top two**. Full
method and numbers in [`docs/SKILL-SELECTION-EVAL.md`](docs/SKILL-SELECTION-EVAL.md).

Three phrasings are known **not** to route well, because no bundled description claims them:

| If you ask about…                          | What happens                         | Why                                                                                        |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| an existing CI pipeline that just went red | picks `debugging-and-error-recovery` | `ci-cd-and-automation` describes _authoring_ pipelines and never mentions diagnosis        |
| running an existing test suite             | picks nothing                        | `test-driven-development` is about _writing_ tests                                         |
| deploying to **staging**                   | picks nothing                        | no description names a non-production environment; `shipping-and-launch` says "production" |

These are gaps in the upstream skill files, not in this node, and they are deliberately not patched
here — the files are vendored byte-for-byte and editing them would break the fidelity guarantee in
[`NOTICE`](NOTICE). Name the skill explicitly in your prompt to route past them, or supply your own
skills directory with wording that covers your cases.

### ⚠️ Trust boundary — read this

**Skill text becomes instructions to an agent that holds real, side-effecting tools. Whoever can
write into the skills directory can steer any agent this node is attached to** — including which
tools it calls and with what arguments.

The **Skills Directory** input is the live vector: any flow editor can repoint it at any directory
the server process can read.

What the node does about it:

-   Skill text is returned **delimited and labelled as untrusted reference material**, inside an
    `<agent-skill>` element with an explicit "REFERENCE MATERIAL — NOT AN INSTRUCTION" preamble, so a
    model is told what it is reading.
-   Attempts to forge the closing markers from inside a skill body are escaped, so a body cannot end
    the quoted region early and have the rest read as trusted narration.
-   Only files named `SKILL.md` are opened, only one directory deep, symlinks are refused, at most
    500 entries are scanned, and files above 1 MB are skipped. It is not a general file reader.
-   Nothing read from disk is ever evaluated, compiled or executed. No `eval`, no `new Function`, no
    `child_process`. This is enforced by a test, not just a promise.

What it does **not** do: it cannot tell a good instruction from a malicious one. Treat a skills
directory with the same care you would give the agent's system prompt.

For context on scale: a flow editor in stock Flowise can already add a _Custom Tool_ that executes
arbitrary server-side JavaScript. This node does not introduce a new privilege class for flow
editors — but it deliberately avoids widening the existing one.

### Operational notes

-   **Use an Agent node, not the standalone AgentFlow v2 _Tool_ node.** That node invokes every tool
    in an array with the same arguments and joins the results, which would fire all 24 skills at once.
-   **Leave "Require Human Input" off.** When a user rejects one tool call, Flowise strips every tool
    sharing the same source node — so rejecting a single skill removes all of them for the rest of
    the run.

### Licensing

The bundled skills are MIT, © 2025 Addy Osmani, pinned at upstream commit `df1edb2e`. Their license
is reproduced verbatim at `packages/components/skills-library/LICENSE`, and provenance is recorded
in `packages/components/skills-library/VENDOR.md`. See the root `NOTICE` for the full picture,
including Flowise's own dual license.

---

## ⚡Quick Start

Download and Install [NodeJS](https://nodejs.org/en/download) >= 20.0.0

1. Install Flowise
    ```bash
    npm install -g flowise
    ```
2. Start Flowise

    ```bash
    npx flowise start
    ```

3. Open [http://localhost:3000](http://localhost:3000)

## 🐳 Docker

### Docker Compose

1. Clone the Flowise project
2. Go to `docker` folder at the root of the project
3. Copy `.env.example` file, paste it into the same location, and rename to `.env` file
4. `docker compose up -d`
5. Open [http://localhost:3000](http://localhost:3000)
6. You can bring the containers down by `docker compose stop`

### Docker Image

1. Build the image locally:

    ```bash
    docker build --no-cache -t flowise .
    ```

2. Run image:

    ```bash
    docker run -d --name flowise -p 3000:3000 flowise
    ```

3. Stop image:

    ```bash
    docker stop flowise
    ```

## 👨‍💻 Developers

Flowise has 3 different modules in a single mono repository.

-   `server`: Node backend to serve API logics
-   `ui`: React frontend
-   `components`: Third-party nodes integrations
-   `api-documentation`: Auto-generated swagger-ui API docs from express

### Prerequisite

-   Install [PNPM](https://pnpm.io/installation)
    ```bash
    npm i -g pnpm
    ```

### Setup

1.  Clone the repository:

    ```bash
    git clone https://github.com/FlowiseAI/Flowise.git
    ```

2.  Go into repository folder:

    ```bash
    cd Flowise
    ```

3.  Install all dependencies of all modules:

    ```bash
    pnpm install
    ```

4.  Build all the code:

    ```bash
    pnpm build
    ```

    <details>
    <summary>Exit code 134 (JavaScript heap out of memory)</summary>  
    If you get this error when running the above `build` script, try increasing the Node.js heap size and run the script again:

    ```bash
    # macOS / Linux / Git Bash
    export NODE_OPTIONS="--max-old-space-size=4096"

    # Windows PowerShell
    $env:NODE_OPTIONS="--max-old-space-size=4096"

    # Windows CMD
    set NODE_OPTIONS=--max-old-space-size=4096
    ```

    Then run:

    ```bash
    pnpm build
    ```

    </details>

5.  Start the app:

    ```bash
    pnpm start
    ```

    You can now access the app on [http://localhost:3000](http://localhost:3000)

6.  For development build:

    -   Create `.env` file and specify the `VITE_PORT` (refer to `.env.example`) in `packages/ui`
    -   Create `.env` file and specify the `PORT` (refer to `.env.example`) in `packages/server`
    -   Run:

        ```bash
        pnpm dev
        ```

    Any code changes will reload the app automatically on [http://localhost:8080](http://localhost:8080)

## 🌱 Env Variables

Flowise supports different environment variables to configure your instance. You can specify the following variables in the `.env` file inside `packages/server` folder. Read [more](https://github.com/FlowiseAI/Flowise/blob/main/CONTRIBUTING.md#-env-variables)

## 📖 Documentation

You can view the Flowise Docs [here](https://docs.flowiseai.com/)

## 🌐 Self Host

Deploy Flowise self-hosted in your existing infrastructure, we support various [deployments](https://docs.flowiseai.com/configuration/deployment)

-   [AWS](https://docs.flowiseai.com/configuration/deployment/aws)
-   [Azure](https://docs.flowiseai.com/configuration/deployment/azure)
-   [Digital Ocean](https://docs.flowiseai.com/configuration/deployment/digital-ocean)
-   [GCP](https://docs.flowiseai.com/configuration/deployment/gcp)
-   [Alibaba Cloud](https://computenest.console.aliyun.com/service/instance/create/default?type=user&ServiceName=Flowise社区版)
-   <details>
      <summary>Others</summary>

    -   [Railway](https://docs.flowiseai.com/configuration/deployment/railway)

        [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/pn4G8S?referralCode=WVNPD9)

    -   [Northflank](https://northflank.com/stacks/deploy-flowiseai)

        [![Deploy to Northflank](https://assets.northflank.com/deploy_to_northflank_smm_36700fb050.svg)](https://northflank.com/stacks/deploy-flowiseai)

    -   [Render](https://docs.flowiseai.com/configuration/deployment/render)

        [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://docs.flowiseai.com/configuration/deployment/render)

    -   [HuggingFace Spaces](https://docs.flowiseai.com/configuration/deployment/hugging-face)

        <a href="https://huggingface.co/spaces/FlowiseAI/Flowise"><img src="https://huggingface.co/datasets/huggingface/badges/raw/main/open-in-hf-spaces-sm.svg" alt="HuggingFace Spaces"></a>

    -   [Elestio](https://elest.io/open-source/flowiseai)

        [![Deploy on Elestio](https://elest.io/images/logos/deploy-to-elestio-btn.png)](https://elest.io/open-source/flowiseai)

    -   [Sealos](https://template.sealos.io/deploy?templateName=flowise)

        [![Deploy on Sealos](https://sealos.io/Deploy-on-Sealos.svg)](https://template.sealos.io/deploy?templateName=flowise)

    -   [RepoCloud](https://repocloud.io/details/?app_id=29)

        [![Deploy on RepoCloud](https://d16t0pc4846x52.cloudfront.net/deploy.png)](https://repocloud.io/details/?app_id=29)

      </details>

## ☁️ Flowise Cloud

Get Started with [Flowise Cloud](https://flowiseai.com/).

## 🙋 Support

Feel free to ask any questions, raise problems, and request new features in [Discussion](https://github.com/FlowiseAI/Flowise/discussions).

## 🙌 Contributing

Thanks go to these awesome contributors

<a href="https://github.com/FlowiseAI/Flowise/graphs/contributors">
<img src="https://contrib.rocks/image?repo=FlowiseAI/Flowise" />
</a><br><br>

See [Contributing Guide](CONTRIBUTING.md). Reach out to us at [Discord](https://discord.gg/jbaHfsRVBW) if you have any questions or issues.

[![Star History Chart](https://api.star-history.com/svg?repos=FlowiseAI/Flowise&type=Timeline)](https://star-history.com/#FlowiseAI/Flowise&Date)

## 📄 License

Flowise is **dual-licensed**, not plain Apache-2.0: the bulk of the source is under the
[Apache License Version 2.0](LICENSE.md), while everything under `packages/server/src/enterprise/`
plus any individually-noticed file (in this tree, `packages/server/src/IdentityManager.ts`) is under
the [FlowiseAI Commercial License](packages/server/src/enterprise/LICENSE.md), which permits
production use only with an Enterprise subscription. Local building, modification and testing are
expressly permitted.

This fork additionally vendors the MIT-licensed [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
library at `packages/components/skills-library/`.

See [`NOTICE`](NOTICE) for the full statement, the exact file counts, and the list of files this fork modified.
