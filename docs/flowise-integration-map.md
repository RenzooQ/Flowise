# Flowise Integration Map — Agent Skills node

**Produced by:** `flowise-explorer` (read-only recon), 2026-08-18
**Target tree:** `C:\Users\bruger1\Desktop\ACLA Agents\flowise-fork` — Flowise **3.1.4**, branch `feat/agent-skills`, upstream `9291856d`.
**Method:** every interface, path and line number below was read out of the checked-out source. Nothing here is
recalled from memory. Where I could **not** execute a command (this agent has no shell), I say so explicitly and
give the command the implementer must run to confirm.

> ⚠️ **Read [§7 Corrections to MASTER_PROMPT.md / INTEGRATION_PLAN.md](#7-corrections-to-master_promptmd-and-docsintegration_planmd) first.**
> Four claims currently in those documents are wrong or incomplete, and two of them are safety-relevant.

---

## 1. Monorepo layout, toolchain, build scripts

### 1.1 Packages

`pnpm-workspace.yaml` (2 lines) declares one glob:

```yaml
packages:
    - 'packages/*'
```

There are **six** packages, not four:

| Path                         | `name`                 | Role                                                    |
| ---------------------------- | ---------------------- | ------------------------------------------------------- |
| `packages/server`            | `flowise`              | Node/Express API, node discovery, oclif CLI (`bin/run`) |
| `packages/ui`                | `flowise-ui`           | React + Vite canvas                                     |
| `packages/components`        | `flowise-components`   | **all nodes** — the only package we touch               |
| `packages/api-documentation` | —                      | Swagger docs                                            |
| `packages/agentflow`         | `@flowiseai/agentflow` | AgentFlow v2 React surface                              |
| `packages/observe`           | `@flowiseai/observe`   | execution-observability React surface                   |

The standing brief for this agent listed only four packages; that is stale. `MASTER_PROMPT.md:22-24` already
lists all six correctly.

### 1.2 Toolchain versions

`package.json:105-108`:

```json
"engines": {
    "node": "^24",
    "pnpm": "^10.26.0"
}
```

CI (`.github/workflows/main.yml:17,25`) pins **node 24.15.0** and **pnpm 10.26.0**. The reported local
environment (node v24.18.0, pnpm 10.26.0) satisfies both.

`.npmrc` — **important**, it changes module resolution:

```
auto-install-peers = true
strict-peer-dependencies = false
prefer-workspace-packages = true
link-workspace-packages = deep
hoist = true
shamefully-hoist = true
engine-strict = false
```

`shamefully-hoist = true` means every transitive dependency is hoisted into the workspace-root
`node_modules/`, so an _undeclared_ dependency still resolves at runtime. Flowise already relies on this
(see §6.6).

### 1.3 Build scripts

Root `package.json:13-38`:

```json
"build": "turbo run build",
"build-force": "pnpm clean && turbo run build --force",
"dev": "turbo run dev --parallel --no-cache",
"start:windows": "cd packages/server/bin && run start",
"test": "turbo run test",
"lint": "eslint \"**/*.{js,jsx,ts,tsx,json,md}\"",
"clean": "pnpm -r clean"
```

`turbo.json` (whole file):

```json
{
    "$schema": "https://turbo.build/schema.json",
    "pipeline": {
        "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
        "test": {},
        "test:coverage": {},
        "dev": { "cache": false }
    }
}
```

`packages/components/package.json:18` — the components build is exactly two steps:

```json
"build": "tsc && gulp",
```

There is **no `dev` script in `packages/components`.** `pnpm dev` therefore starts only the server
(`nodemon`) and the UI (`vite`); it does **not** rebuild components. See §6.1.

---

## 2. The node system in `packages/components`

### 2.1 Directory organisation

Nodes live at `packages/components/nodes/<category>/<NodeName>/<NodeName>.ts`, with the icon file beside
the `.ts`. Categories present under `nodes/`: `agentflow`, `agents`, `analytic`, `cache`, `chains`,
`chatmodels`, `documentloaders`, `embeddings`, `engine`, `llms`, `memory`, `moderation`, `multiagents`,
`outputparsers`, `prompts`, `recordmanager`, `retrievers`, `sequentialagents`, `textsplitters`, **`tools`**,
`utilities`, `vectorstores`. Shared per-node helpers conventionally go in a sibling `core.ts`.

`packages/components/nodes/index.ts` is **not** a node registry — it is 13 lines re-exporting MCP helpers:

```ts
/**
 * Node-level utilities. Prefer importing from 'flowise-components/nodes' so that
 * refactors under nodes/ do not break consumers.
 */
export {
    MCPToolkit,
    MCPTool,
    validateArgsForLocalFileAccess,
    ...
} from './tools/MCP/core'
```

**There is no file listing the nodes.** Registration is by directory scan (§4).

### 2.2 `INodeParams` — `packages/components/src/Interface.ts:80-118`

```ts
export interface INodeParams {
    label: string
    name: string
    type: NodeParamsType | string
    default?: CommonType | ICommonObject | ICommonObject[]
    description?: string
    warning?: string
    options?: Array<INodeOptionsValue>
    datagrid?: Array<ICommonObject>
    credentialNames?: Array<string>
    optional?: boolean | INodeDisplay
    step?: number
    rows?: number
    list?: boolean
    acceptVariable?: boolean
    acceptNodeOutputAsVariable?: boolean
    placeholder?: string
    fileType?: string
    additionalParams?: boolean
    loadMethod?: string
    loadConfig?: boolean
    hidden?: boolean
    client?: Array<ClientType>
    hideCodeExecute?: boolean
    codeExample?: string
    hint?: Record<string, string>
    tabIdentifier?: string
    tabs?: Array<INodeParams>
    refresh?: boolean
    freeSolo?: boolean
    loadPreviousNodes?: boolean
    array?: Array<INodeParams>
    show?: INodeDisplay
    hide?: INodeDisplay
    generateDocStoreDescription?: boolean
    generateInstruction?: boolean
    minItems?: number
    maxItems?: number
}
```

Required: **`label`, `name`, `type` only.** `type` is `NodeParamsType | string`; `NodeParamsType`
(`Interface.ts:9-24`) is:

```ts
export type NodeParamsType =
    | 'asyncOptions'
    | 'asyncMultiOptions'
    | 'options'
    | 'multiOptions'
    | 'datagrid'
    | 'string'
    | 'number'
    | 'boolean'
    | 'password'
    | 'json'
    | 'code'
    | 'date'
    | 'file'
    | 'folder'
    | 'tabs'
```

Supporting types you will need: `INodeOptionsValue` (`Interface.ts:61-69`) is
`{ label, name, description?, imageSrc?, client?, show?, hide? }`.

### 2.3 `INodeProperties` — `Interface.ts:128-148` (the required-field list)

```ts
export interface INodeProperties {
    label: string
    name: string
    type: string
    icon: string
    version: number
    category: string // TODO: use enum instead of string
    baseClasses: string[]
    tags?: string[]
    description?: string
    filePath?: string
    badge?: string
    deprecateMessage?: string
    hideOutput?: boolean
    hideInput?: boolean
    author?: string
    documentation?: string
    color?: string
    hint?: string
    warning?: string
}
```

**Required on every node: `label`, `name`, `type`, `icon`, `version`, `category`, `baseClasses`.**
`description` is **optional**; `inputs` is **optional** (it lives on `INode`, not here); `filePath` is
filled in by the loader (`NodesPool.ts:48`). ⚠️ `version: number` is required and is _not_ mentioned in
either planning doc's field list.

⚠️ `author` is required to be **absent** unless you want the node gated: `NodesPool.ts:73-76` hides any
node that sets `author` when `appConfig.showCommunityNodes` is false. **Do not set `author`.**

### 2.4 `INode` — `Interface.ts:150-164` (with the real `init()` signature)

```ts
export interface INode extends INodeProperties {
    credential?: INodeParams
    inputs?: INodeParams[]
    output?: INodeOutputsValue[]
    loadMethods?: {
        [key: string]: (nodeData: INodeData, options?: ICommonObject) => Promise<INodeOptionsValue[]>
    }
    vectorStoreMethods?: {
        upsert: (nodeData: INodeData, options?: ICommonObject) => Promise<IndexingResult | void>
        search: (nodeData: INodeData, options?: ICommonObject) => Promise<any>
        delete: (nodeData: INodeData, ids: string[], options?: ICommonObject) => Promise<void>
    }
    init?(nodeData: INodeData, input: string, options?: ICommonObject): Promise<any>
    run?(nodeData: INodeData, input: string, options?: ICommonObject): Promise<string | ICommonObject>
}
```

**The exact contract:**

-   `init?(nodeData: INodeData, input: string, options?: ICommonObject): Promise<any>` — **optional**,
    returns `Promise<any>`. Tool nodes implement `init()` and return the LangChain tool (or an array of
    tools, §3.3). `input` is `''` for tool nodes; callers pass `('', options)`.
-   `run?(nodeData, input, options): Promise<string | ICommonObject>` — **optional**. Only executable
    nodes (Agents, AgentFlow nodes, Chains) implement it. **A Tool node does not implement `run()`.**
-   `loadMethods` is how `asyncOptions` / `asyncMultiOptions` inputs are populated. Called from the server
    via `POST /api/v1/node-load-method/:name` (`packages/server/src/services/nodes/index.ts:95-118`); the
    `options` bag it receives there is `{ appDataSource, databaseEntities, componentNodes, previousNodes,
currentNode, searchOptions, cachePool }`. Note the surrounding `try/catch` at
    `services/nodes/index.ts:119-120` swallows errors and **returns `[]`**, so a throwing `loadMethod`
    shows as an empty dropdown, not an error.

### 2.5 `INodeData` — `Interface.ts:166-173`

```ts
export interface INodeData extends INodeProperties {
    id: string
    inputs?: ICommonObject
    outputs?: ICommonObject
    credential?: string
    instance?: any
    loadMethod?: string // method to load async options
}
```

So inside `init()` you read user input as `nodeData.inputs?.<paramName>` and it is typed `any` — every
existing node casts, e.g. `const path = (nodeData.inputs?.path as string) || ''`
(`JSONPathExtractor.ts:114`).

### 2.6 `getBaseClasses` — `packages/components/src/utils.ts:130-148`

```ts
export const getBaseClasses = (targetClass: any) => {
    const baseClasses: string[] = []
    const skipClassNames = ['BaseLangChain', 'Serializable']

    if (targetClass instanceof Function) {
        let baseClass = targetClass
        while (baseClass) {
            const newBaseClass = Object.getPrototypeOf(baseClass)
            if (newBaseClass && newBaseClass !== Object && newBaseClass.name) {
                baseClass = newBaseClass
                if (!skipClassNames.includes(baseClass.name)) baseClasses.push(baseClass.name)
            } else break
        }
    }
    return baseClasses
}
```

It walks the prototype chain by **class name**, which is why `baseClasses` must end up containing the
string `'Tool'` for the UI to let you wire the node into an Agent's `Tools` socket. Two idioms are in use
and both work:

-   `this.baseClasses = [this.type, ...getBaseClasses(MyToolClass)]` — Calculator, JSONPathExtractor, AWSDynamoDBKVStorage
-   `this.baseClasses = [this.type, 'Tool']` — CurrentDateTime, Gmail

⚠️ `getBaseClasses(SomeClassExtendingStructuredTool)` yields `['StructuredTool', 'BaseTool', ...]` — it does
**not** produce the literal `'Tool'`. For a class extending `StructuredTool`, use
`[this.type, 'Tool', ...getBaseClasses(MyToolClass)]` or just `[this.type, 'Tool']` so the classic
`ToolAgent` socket (`type: 'Tool'`, `ToolAgent.ts:47-51`) accepts it.

---

## 3. Tool nodes — the base classes, and which one to copy

### 3.1 ⚠️ THREE different classes are named `DynamicStructuredTool` in this tree. Two of them run `eval`.

| #   | Import path                            | `_call()` behaviour                                                | Verdict                    |
| --- | -------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| 1   | `@langchain/core/tools`                | upstream LangChain; calls `this.func`                              | ✅ **USE THIS**            |
| 2   | `nodes/tools/CustomTool/core`          | `executeJavaScriptCode(this.code, sandbox)`                        | ❌ **NEVER**               |
| 3   | `nodes/tools/OpenAPIToolkit/core`      | `executeJavaScriptCode(this.customCode \|\| defaultCode, sandbox)` | ❌ **NEVER**               |
| (4) | file-local class in `RetrieverTool.ts` | calls `this.func`                                                  | eval-free but not exported |

**#2 — `packages/components/nodes/tools/CustomTool/core.ts`.** Declaration at line 32-35, and the hazard at
line 108-134:

```ts
export class DynamicStructuredTool<...> extends StructuredTool {
    ...
    protected async _call(arg, _?, flowConfig?): Promise<string> {
        ...
        const sandbox = createCodeExecutionSandbox('', this.variables || [], flow, additionalSandbox)
        let response = await executeJavaScriptCode(this.code, sandbox)     // ← core.ts:127
```

**#3 — `packages/components/nodes/tools/OpenAPIToolkit/core.ts`** — **this one is missing from
`docs/INTEGRATION_PLAN.md` and it is equally dangerous.** Declaration at line 124-127, hazard at line 256:

```ts
const sandbox = createCodeExecutionSandbox('', this.variables || [], flow, additionalSandbox)
let response = await executeJavaScriptCode(this.customCode || defaultCode, sandbox) // ← core.ts:256
```

Eight Tools-category nodes extend #3 (`Gmail`, `GoogleCalendar`, `GoogleDocs`, `GoogleDrive`,
`GoogleSheets`, `Jira`, `MicrosoftOutlook`, `MicrosoftTeams`) — their subclasses override `_call`, so they
never eval, but the base class can. **Do not copy from any of those eight.**

### 3.2 ⚠️ `CurrentDateTime` — CONFIRMED DANGEROUS as a reference

`packages/components/nodes/tools/CurrentDateTime/CurrentDateTime.ts:3` reads, verbatim:

```ts
import { DynamicStructuredTool } from '../CustomTool/core'
```

and `CurrentDateTime.ts:60-71`:

```ts
    async init(): Promise<any> {
        const obj = {
            name: 'current_date_time',
            description: 'Useful to get current day, date and time.',
            schema: z.object({}),
            code: code            // ← a JS source string, executed by executeJavaScriptCode
        }
        let dynamicStructuredTool = new DynamicStructuredTool(obj)
        return dynamicStructuredTool
    }
```

`INTEGRATION_PLAN.md`'s warning about `CurrentDateTime` is **confirmed correct**. Do not copy it.

### 3.3 The safe import path — verified against the installed package

`@langchain/core@1.1.20` (root `package.json:113` pins it via `resolutions`). Declarations read from
`node_modules/.pnpm/@langchain+core@1.1.20_@ope_0a89b6359d1d16e40407a7af28ddd255/node_modules/@langchain/core/dist/tools/index.d.ts`:

-   `StructuredTool` — line 132 shows it as `DynamicStructuredTool`'s parent
-   `DynamicTool` — line 104
-   `DynamicStructuredTool` — line 132:
    ```ts
    declare class DynamicStructuredTool<SchemaT = ToolInputSchemaBase, SchemaOutputT = ..., SchemaInputT = ...,
        ToolOutputT = ToolOutputType, NameT extends string = string>
        extends StructuredTool<SchemaT, SchemaOutputT, SchemaInputT, ToolOutputT> {
        static lc_name(): string;
        name: NameT;
        description: string;
        func: DynamicStructuredToolInput<SchemaT, SchemaOutputT, ToolOutputT>["func"];
        schema: SchemaT;
        constructor(fields: DynamicStructuredToolInput<SchemaT, SchemaOutputT, ToolOutputT> & { name: NameT });
        protected _call(arg, runManager?, parentConfig?): Promise<ToolOutputT>;
    }
    ```
-   `tool()` factory and `BaseToolkit` are also exported (`MCP/core.ts:1` imports `{ BaseToolkit, tool, Tool }`).

**Exact import line the implementer must write:**

```ts
import { StructuredTool } from '@langchain/core/tools'
```

**Exact import lines the implementer must never write:**

```ts
import { DynamicStructuredTool } from '../CustomTool/core' // executes JavaScript
import { DynamicStructuredTool } from '../OpenAPIToolkit/core' // executes JavaScript
```

Zod: installed `zod@4.3.6`, but **every node imports the v3 compatibility surface**:
`import { z } from 'zod/v3'` (Calculator's neighbours: `CurrentDateTime.ts:1`, `RetrieverTool.ts:1`,
`JSONPathExtractor.ts:1`, `CustomTool/core.ts:1`, `Gmail/core.ts:1`). Match that — `zod/v3`, not `zod`.

### 3.4 Nodes read in full

**`nodes/tools/Calculator/Calculator.ts`** (31 lines, the whole file):

```ts
import { INode } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { Calculator } from '@langchain/community/tools/calculator'

class Calculator_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]

    constructor() {
        this.label = 'Calculator'
        this.name = 'calculator'
        this.version = 1.0
        this.type = 'Calculator'
        this.icon = 'calculator.svg'
        this.category = 'Tools'
        this.description = 'Perform calculations on response'
        this.baseClasses = [this.type, ...getBaseClasses(Calculator)]
    }

    async init(): Promise<any> {
        return new Calculator()
    }
}

module.exports = { nodeClass: Calculator_Tools }
```

Eval-free, but it has **no `inputs`, no schema and no hand-written tool class** — it just returns a
prebuilt community tool. Too thin to copy for our purposes.

**`nodes/tools/RetrieverTool/RetrieverTool.ts`** — eval-free (`RetrieverTool.ts:3` imports
`BaseDynamicToolInput, DynamicTool, StructuredTool, ToolInputParsingException` from `@langchain/core/tools`),
but it pays for that by **redeclaring its own 90-line `DynamicStructuredTool`** (lines 21-117) with a
hand-rolled `call()` that duplicates callback-manager plumbing. `init()` (line 182-222) builds one tool with
`new DynamicStructuredTool({ ...input, func, schema })`. Correct, but 90 lines of boilerplate we do not need.

**`nodes/tools/JSONPathExtractor/JSONPathExtractor.ts`** — 125 lines. Header:

```ts
import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import { INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { get } from 'lodash'

class JSONPathExtractorTool extends StructuredTool {
    name = 'json_path_extractor'
    description = 'Extract value from JSON using configured path'
    schema = z.object({ ... })

    private readonly path: string
    private readonly returnNullOnError: boolean

    constructor(path: string, returnNullOnError: boolean = false) { super(); ... }

    async _call({ json }: z.infer<typeof this.schema>): Promise<string> { ... }
}
```

and its `init()` (lines 113-125):

```ts
    async init(nodeData: INodeData, _: string): Promise<any> {
        const path = (nodeData.inputs?.path as string) || ''
        const returnNullOnError = (nodeData.inputs?.returnNullOnError as boolean) || false
        if (!path) throw new Error('JSON Path is required')
        return new JSONPathExtractorTool(path, returnNullOnError)
    }
```

**`nodes/tools/AWSDynamoDBKVStorage/AWSDynamoDBKVStorage.ts`** — same shape as JSONPathExtractor
(`StructuredTool` from `@langchain/core/tools` at line 2), plus it demonstrates `loadMethods` for
`asyncOptions` and returns a _different_ tool class depending on an input (lines 370-374). Also has a
colocated `.test.ts`.

**`nodes/tools/Gmail/Gmail.ts`** — the canonical **array-returning** Tools node: `init()` (lines 551-584)
ends with `const tools = createGmailTools({...}); return tools`. But it derives from the eval-capable
`OpenAPIToolkit/core` base class, so copy only the _`return tools`_ idea from it, not the code.

### 3.5 CANONICAL REFERENCE NODE — `JSONPathExtractor`

**Copy `packages/components/nodes/tools/JSONPathExtractor/JSONPathExtractor.ts`.**

Why this one:

1. **Eval-free by construction.** It imports `StructuredTool` directly from `@langchain/core/tools`
   (line 2) — the safe path — and never touches `CustomTool/core` or `OpenAPIToolkit/core`.
2. **It is the smallest node that has everything we need at once**: a hand-written tool class with a
   `name`/`description`/`zod` schema set as class fields, constructor-injected configuration, real
   `INodeParams` inputs (`string` + `boolean` with `optional`/`additionalParams`), `getBaseClasses`,
   input validation with a thrown `Error`, and `module.exports = { nodeClass: ... }`.
3. **Its `_call` returns a plain string** — exactly the progressive-disclosure contract (return the skill
   body as text).
4. **It has a colocated `JSONPathExtractor.test.ts`**, proving the test placement the test-engineer will
   need (jest `roots` includes `<rootDir>/nodes`, `jest.config.js:4`).
5. It is a recent, lint-clean, prettier-clean node, so a copy will not fight `prettier/prettier: error`.

**One deviation from the reference is required:** we return **one tool per selected skill**, i.e. `init()`
returns `Tool[]`, whereas JSONPathExtractor returns a single tool. That is fully supported — see §3.6.
Take the _array-return_ shape from `Gmail.ts:583` (`return tools`) and nothing else from Gmail.

### 3.6 Returning an array of tools — confirmed in three consumers

**AgentFlow v2 Agent** — `packages/components/nodes/agentflow/Agent/Agent.ts:719-737`, verbatim:

```ts
const toolInstance = await newToolNodeInstance.init(newNodeData, '', options)

// toolInstance might returns a list of tools like MCP tools
if (Array.isArray(toolInstance)) {
    for (const subTool of toolInstance) {
        const subToolInstance = subTool as Tool
        ;(subToolInstance as any).agentSelectedTool = tool.agentSelectedTool
        if (tool.agentSelectedToolRequiresHumanInput) {
            ;(subToolInstance as any).requiresHumanInput = true
        }
        toolsInstance.push(subToolInstance)
    }
} else {
    if (tool.agentSelectedToolRequiresHumanInput) {
        toolInstance.requiresHumanInput = true
    }
    toolsInstance.push(toolInstance as Tool)
}
```

The downstream `availableTools` map (`Agent.ts:739-758`) reads `(tool as any)?.agentSelectedTool` first and
only falls back to `tools[index]`, so the index skew caused by one node yielding N tools is already handled.

**AgentFlow v2 Tool node** — `packages/components/nodes/agentflow/Tool/Tool.ts:152-158` merges the schemas of
an array, and `Tool.ts:283-289` executes all of them and combines outputs.

**Classic chatflow `Tool Agent`** — `packages/components/nodes/agents/ToolAgent/ToolAgent.ts:269`:

```ts
let tools = nodeData.inputs?.tools
tools = flatten(tools)
```

(`flatten` from lodash, imported at `ToolAgent.ts:1`; the `tools` input is `{ type: 'Tool', list: true }`,
`ToolAgent.ts:46-51`). So a nested array from one node is flattened. Confirmed on both canvases.

`INTEGRATION_PLAN.md`'s claim here is **correct**.

### 3.7 ⚠️ Tool-name sanitisation — the plan is WRONG about this

`INTEGRATION_PLAN.md:120` says _"Tool names are already sanitized by Flowise to `[a-z0-9_-]`, capped at 64
chars."_ **That is not true for tools returned by Tool nodes.**

The function exists — `packages/components/nodes/agentflow/Agent/Agent.ts:78-97`:

```ts
/**
 * Sanitizes a string to be used as a tool name.
 * Restricts to ASCII characters [a-z0-9_-] for LLM API compatibility (OpenAI, Anthropic, Gemini).
 * Non-ASCII titles (Korean, Chinese, Japanese, etc.) will use auto-generated fallback names.
 * This prevents 'Invalid tools[0].function.name: empty string' errors.
 */
const sanitizeToolName = (name: string): string => {
    const sanitized = name
        .toLowerCase()
        .replace(/ /g, '_')
        .replace(/[^a-z0-9_-]/g, '') // ASCII only for LLM API compatibility

    // If the result is empty (e.g., non-ASCII only input), generate a unique fallback name
    if (!sanitized) {
        return `tool_${Date.now()}_${randomBytes(4).toString('hex').slice(0, 5)}`
    }

    // Enforce 64 character limit common for tool names
    return sanitized.slice(0, 64)
}
```

…but it is **module-private** (`const`, not exported) and every call site is a knowledge-base-derived
retriever tool: `Agent.ts:791`, `Agent.ts:805`, `Agent.ts:863`, `Agent.ts:877`. Grep across
`packages/**/*.ts` returns exactly those four call sites plus the declaration. **Nothing sanitises the
`name` of a tool object handed back from a Tool node's `init()`.**

The only other sanitiser is MCP-local and also not reusable from our node:
`packages/components/nodes/tools/MCP/core.ts:60-72`:

```ts
export function sanitizeMCPToolName(name: string): string {
    const maxLen = getMCPToolNameMaxLength()
    const trimmed = name.trim()
    // Allow alphanumeric, underscore, hyphen — matches MCP spec and existing CustomMcpServerTool.formatToolName
    const cleaned = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLen)
    ...
}
```

(It _is_ exported and re-exported via `nodes/index.ts`, but importing it drags in the MCP SDK, which is
ESM-only and is explicitly stubbed in jest — `jest.config.js:20`. **Do not import it.**)

Precedent for a node sanitising its own tool name inline:
`nodes/tools/RequestsGet/RequestsGet.ts:129`, `RequestsPost/RequestsPost.ts:139`,
`RequestsPut/RequestsPut.ts:139`, `RequestsDelete/RequestsDelete.ts:129`, `Arxiv/Arxiv.ts:129` — all do
`.replace(/[^a-z0-9_-]/g, '')`.

**⇒ Action for the implementer: the Agent Skills node MUST sanitise and de-duplicate its own tool names**
(lowercase, spaces→`_`, strip to `[a-z0-9_-]`, slice to 64, and disambiguate collisions — 24 skill names
sliced to 64 chars could in principle collide, and two tools with the same name is an API error).

---

## 4. Discovery, registration, icons

### 4.1 The scanner — `packages/server/src/NodesPool.ts`

Lines 26-31:

```ts
    private async initializeNodes() {
        const packagePath = getNodeModulesPackagePath('flowise-components')
        const nodesPath = path.join(packagePath, 'dist', 'nodes')
        const nodes = await this.loadNodesFromDir(nodesPath)
        Object.assign(this.componentNodes, nodes)
    }
```

Lines 36-49 and 70-83:

```ts
    async loadNodesFromDir(dir: string): Promise<IComponentNodes> {
        const disabled_nodes = process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : []
        const nodes: IComponentNodes = {}
        const nodeFiles = await this.getFiles(dir)
        await Promise.all(
            nodeFiles.map(async (file) => {
                if (file.endsWith('.js')) {
                    try {
                        const nodeModule = await require(file)
                        if (nodeModule.nodeClass) {
                            const newNodeInstance = new nodeModule.nodeClass()
                            newNodeInstance.filePath = file
                            ...
                            const skipCategories = ['Analytic', 'SpeechToText']
                            const conditionOne = !skipCategories.includes(newNodeInstance.category)
                            const isCommunityNodesAllowed = appConfig.showCommunityNodes
                            const isAuthorPresent = newNodeInstance.author
                            let conditionTwo = true
                            if (!isCommunityNodesAllowed && isAuthorPresent) conditionTwo = false
                            const isDisabled = disabled_nodes.includes(newNodeInstance.name)
                            if (conditionOne && conditionTwo && !isDisabled) {
                                nodes[newNodeInstance.name] = newNodeInstance
                            }
                        }
                    } catch (err) {
                        logger.error(`❌ [server]: Error during initDatabase with file ${file}:`, err)
                    }
                }
            })
        )
        return nodes
    }
```

`getFiles` (lines 119-128) recurses the whole tree. `getNodeModulesPackagePath`
(`packages/server/src/utils/index.ts:133-147`) probes `node_modules/<pkg>` from 1 to 5 levels above
`__dirname` and returns the first that exists — in this workspace that is
`packages/server/node_modules/flowise-components`, a pnpm symlink to `packages/components`.

**Confirmed:** the loader scans `dist/nodes` recursively for `.js` exporting `nodeClass`. **There is no index
file to edit.** Drop the directory in, build, restart.

Three consequences the implementer must respect:

-   **Helper `.js` files under the node dir must not export `nodeClass`** or they become phantom nodes.
-   **Import-time throws are swallowed** (line 84-86) — the node vanishes from the palette with only a log
    line. Do all file I/O lazily inside `init()`, never at module top level.
-   **`tsc` never deletes stale output.** Renaming `Foo.ts` leaves `dist/nodes/.../Foo.js` behind and
    NodesPool will keep loading it. Run `pnpm --filter flowise-components clean` after any rename.

### 4.2 Icon resolution — `NodesPool.ts:50-68`

```ts
                            // Replace file icon with absolute path
                            if (
                                newNodeInstance.icon &&
                                (newNodeInstance.icon.endsWith('.svg') ||
                                    newNodeInstance.icon.endsWith('.png') ||
                                    newNodeInstance.icon.endsWith('.jpg'))
                            ) {
                                const filePath = file.replace(/\\/g, '/').split('/')
                                filePath.pop()
                                const nodeIconAbsolutePath = `${filePath.join('/')}/${newNodeInstance.icon}`
                                newNodeInstance.icon = nodeIconAbsolutePath
                                ...
                            }
```

So `this.icon = 'agentskills.svg'` becomes
`<...>/dist/nodes/tools/AgentSkills/agentskills.svg` in memory. The server then streams it verbatim —
`packages/server/src/controllers/node-icons/index.ts:19-21`:

```ts
            if (nodeInstance.icon.endsWith('.svg') || nodeInstance.icon.endsWith('.png') || nodeInstance.icon.endsWith('.jpg')) {
                const filepath = nodeInstance.icon
                res.sendFile(filepath)
```

Route mounted at `packages/server/src/routes/index.ts:104` → `GET /api/v1/node-icon/:name`.

**The icon only exists in `dist` because gulp copies it** (§5.2). Only `.svg`/`.png`/`.jpg` are recognised
(case-sensitively, `.endsWith`).

### 4.3 Credentials

Not needed for this node. For reference: `NodesPool.ts:96-112` scans `dist/credentials` for
`*.credential.js` exporting `credClass`, and a credential's icon is inherited from whichever node declared
it in `credential.credentialNames` (`NodesPool.ts:62-67`).

### 4.4 How the UI gets the catalogue

-   REST: `packages/server/src/routes/nodes/index.ts` — `GET /`, `GET /:name`, `GET /category/:name`, served
    from the in-memory `appServer.nodesPool.componentNodes`
    (`packages/server/src/services/nodes/index.ts:18-30`).
-   UI client: `packages/ui/src/api/nodes.js:3` — `client.get('/nodes', { params: { client: 'agentflowv2' } })`.
    The `client` param only filters _inputs_ that declare a `client` array
    (`packages/server/src/services/nodes/filterNodeByClient.ts:8-27`); nodes themselves are never filtered by it.
-   Palette grouping: `packages/ui/src/views/canvas/AddNodes.jsx:266-267` groups purely by `nd.category`.
    `AddNodes.jsx:58` — `const blacklistCategoriesForAgentCanvas = ['Agents', 'Memory', 'Record Manager', 'Utilities']`.
    **`Tools` is not blacklisted on either canvas**, so `category = 'Tools'` shows up with no UI change.
-   Agent tool picker: `packages/components/nodes/agentflow/Agent/Agent.ts:608-631`:
    ```ts
          async listTools(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
              const componentNodes = options.componentNodes as { [key: string]: INode }
              const removeTools = ['chainTool', 'retrieverTool', 'webBrowser']
              const returnOptions: INodeOptionsValue[] = []
              for (const nodeName in componentNodes) {
                  const componentNode = componentNodes[nodeName]
                  if (componentNode.category === 'Tools' || componentNode.category === 'Tools (MCP)') {
                      if (componentNode.tags?.includes('LlamaIndex')) continue
                      if (removeTools.includes(nodeName)) continue
                      returnOptions.push({ label: componentNode.label, name: nodeName, imageSrc: componentNode.icon })
                  }
              }
              return returnOptions
          }
    ```
    Anything with `category === 'Tools'` and a `name` outside `removeTools` appears automatically.

**⇒ Zero UI-package changes are required.** `packages/ui`, `packages/agentflow` and `packages/observe`
need no edit.

---

## 5. Build & run — and skill-file delivery to a BUILT tree

### 5.1 Commands

```powershell
# from C:\Users\bruger1\Desktop\ACLA Agents\flowise-fork
pnpm install                                  # node ^24, pnpm ^10.26.0
pnpm build                                    # turbo run build (6 tasks)
pnpm --filter flowise-components build        # just components: tsc && gulp   <-- the inner loop
pnpm --filter flowise-components clean        # rimraf dist  (needed after renames)
pnpm build-force                              # pnpm clean && turbo run build --force
pnpm start                                    # run-script-os -> packages/server/bin/run start  (port 3000)
pnpm dev                                      # turbo run dev --parallel --no-cache  (server + ui ONLY)
pnpm lint                                     # eslint "**/*.{js,jsx,ts,tsx,json,md}"   <-- CI runs this FIRST
pnpm --filter flowise-components test         # jest
```

**There is no codegen step.** Components builds with plain `tsc` plus one gulp copy task.

### 5.2 `packages/components/gulpfile.ts` — verbatim, all 7 lines

```ts
const { src, dest } = require('gulp')

function copyIcons() {
    return src(['nodes/**/*.{jpg,png,svg}']).pipe(dest('dist/nodes'))
}

exports.default = copyIcons
```

**Exactly one glob: `nodes/**/\*.{jpg,png,svg}`→`dist/nodes`.** Nothing else is copied. Markdown is
**NOT** copied. JSON is **NOT** copied. Files outside `nodes/`are **NOT** copied.`MASTER_PROMPT.md:152`
is correct on this point.

Verified in the built tree: `packages/components/dist/nodes/tools/Calculator/` contains
`Calculator.d.ts`, `Calculator.js`, `Calculator.js.map`, `calculator.svg` — and nothing else.

### 5.3 tsconfig — what determines the `dist` shape

`packages/components/tsconfig.json`:

```json
"outDir": "./dist/",
"resolveJsonModule": true,
"strict": true,
"strictPropertyInitialization": false,
"useUnknownInCatchVariables": false,
"declaration": true,
"module": "commonjs",
"target": "ES2020",
...
"include": ["src", "nodes", "credentials"],
"exclude": ["gulpfile.ts", "node_modules", "dist", "**/*.test.ts", "**/*.test.js", "**/*.spec.ts", "**/*.spec.js"]
```

No explicit `rootDir`, so tsc infers it from the common prefix of the input set. Because
`src/index.ts:7` does `export * from '../evaluation/EvaluationRunner'`, the input set spans
`src/`, `nodes/`, `credentials/` and `evaluation/` — the inferred root is the **package root**, which is
why output lands at `dist/src/…`, `dist/nodes/…`, `dist/credentials/…` (and matches
`"main": "dist/src/index"`). **A new top-level directory containing only `.md` files does not enter the
compilation and cannot shift this.** Do not add stray `.ts` files outside `src`/`nodes`/`credentials`.

### 5.4 ⭐ The `__dirname` arithmetic — with a working precedent in-tree

**This is exactly the problem `models.json` already solves.** `packages/components/models.json` sits at the
package root, is not compiled and is not copied by gulp, and
`packages/components/src/modelLoader.ts:12-20` resolves it like this:

```ts
const getModelsJSONPath = (): string => {
    const checkModelsPaths = [path.join(__dirname, '..', 'models.json'), path.join(__dirname, '..', '..', 'models.json')]
    for (const checkPath of checkModelsPaths) {
        if (fs.existsSync(checkPath)) {
            return checkPath
        }
    }
    return ''
}
```

Two candidates, first hit wins — one for the dev tree (`src/` → `..`), one for the built tree
(`dist/src/` → `../..`). This is shipped, production code. **Copy this pattern.**

Now the arithmetic for a node, with the skills at the components **package root**
(`packages/components/skills-library/`):

| Tree                     | `__dirname`                                        | Segments up to package root    | Resolves to           |
| ------------------------ | -------------------------------------------------- | ------------------------------ | --------------------- |
| **dev / ts-node / jest** | `packages\components\nodes\tools\AgentSkills`      | `..`, `..`, `..` → **3**       | `packages\components` |
| **built (`dist/`)**      | `packages\components\dist\nodes\tools\AgentSkills` | `..`, `..`, `..`, `..` → **4** | `packages\components` |

`dist/` adds exactly one level. Independent confirmation of the dev-tree depth from a real test file:
`packages/components/nodes/chatmodels/AWSBedrock/AWSBedrockCatalog.test.ts:8` uses
`path.join(__dirname, '..', '..', '..', 'models.json')` — 3 up from a node directory.

**Recommended implementation** (probe list, mirroring `modelLoader.ts`, so one code path covers both trees
and any future `dist` nesting):

```ts
const resolveSkillsDir = (override?: string): string => {
    if (override && fs.existsSync(override)) return override
    const candidates = [
        path.join(__dirname, '..', '..', '..', 'skills-library'), // dev tree
        path.join(__dirname, '..', '..', '..', '..', 'skills-library'), // built tree (dist/)
        path.join(__dirname, '..', '..', '..', '..', '..', 'skills-library') // slack, mirrors utils.ts:223-227
    ]
    for (const c of candidates) if (fs.existsSync(c)) return c
    return ''
}
```

The same 1-to-5-levels probe idiom is used three more times in this package:
`src/utils.ts:223-227` (node_modules), `src/utils.ts:555-562` (encryption.key), `src/utils.ts:1043-1047`
(package.json). It is idiomatic Flowise.

**Symlink caveat (low risk, must still be verified).** NodesPool `require()`s an absolute path built from
`packages/server/node_modules/flowise-components` (a pnpm symlink). Node resolves symlinks to their realpath
by default (`--preserve-symlinks` is off), so `__dirname` should be the real
`packages\components\dist\nodes\tools\AgentSkills`. The probe list above is immune either way, since the
symlink path resolves to the same directory tree. **I could not execute this** — the implementer must prove
it, from the _built_ tree, with:

```powershell
cd "C:\Users\bruger1\Desktop\ACLA Agents\flowise-fork"
pnpm --filter flowise-components build
node -e "const m=require('./packages/components/dist/nodes/tools/AgentSkills/AgentSkills.js'); const n=new m.nodeClass(); n.init({id:'t',inputs:{}},'',{}).then(t=>console.log(Array.isArray(t)?t.length+' tools: '+t.map(x=>x.name).join(','):'1 tool')).catch(e=>{console.error(e);process.exit(1)})"
```

That is the "prove it from a BUILT tree" evidence `MASTER_PROMPT.md:154` demands.

### 5.5 Would anything drop a non-`dist` directory?

| Mechanism                                           | Verdict                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `.gitignore`                                   | ✅ Safe. No `*.md` rule. Ignores `**/dist`, `**/build`, `**/node_modules`, `**/tmp`, `**/temp`, `**/uploads`, key/cert patterns, `extensions/`, `apps/*/`. ⚠️ Watch two odd entries: `**/*.org` (line 91) and `*.key` (line 64) — a `SKILL.md` is fine, but any auxiliary `.org` or `.key` file in the vendored library would silently not be committed. |
| `packages/components/.gitignore`                    | Does not exist.                                                                                                                                                                                                                                                                                                                                          |
| `packages/components/.npmignore`                    | Does not exist.                                                                                                                                                                                                                                                                                                                                          |
| `files` field in `packages/components/package.json` | **Not present.** Whole package dir would be packed.                                                                                                                                                                                                                                                                                                      |
| `.dockerignore`                                     | Ignores only `node_modules`, `dist`, `build`, two `.env` files. Safe.                                                                                                                                                                                                                                                                                    |
| `docker/Dockerfile`                                 | ⚠️ **Does not build from local source at all** — line 19 is `RUN npm install -g flowise`. A fork's node can never appear in an image built from this Dockerfile. Do not treat Docker as a delivery path for this work.                                                                                                                                   |
| `.github/workflows/proprietary-path-guard.yml`      | Gated by `if: github.repository == 'FlowiseAI/Flowise'` (line 34) — skipped on a fork.                                                                                                                                                                                                                                                                   |
| Turbo                                               | `outputs: ["dist/**"]` only; a package-root directory is an input, not an output, and is never pruned.                                                                                                                                                                                                                                                   |

### 5.6 ⚠️ Submodule vs copy — recommend **copy**

`MASTER_PROMPT.md:57` sets `SKILLS_VENDOR_MODE = submodule`. Concrete costs of that, in this repo:

-   `git clone` **without** `--recurse-submodules` produces an **empty** `skills-library/`. The node then
    loads, registers, and silently exposes **zero tools** — the worst possible failure mode for a
    demo/e2e/review.
-   `git archive` / a source tarball / the "produce a patch" fallback in `MASTER_PROMPT.md:196` all lose the
    content entirely.
-   Turbo hashes package inputs via git; a gitlink is a single SHA, so skill edits do not invalidate the
    build cache the way file edits do.

A vendored copy costs 24 small Markdown files and removes every one of these. **Record the upstream
`addyosmani/agent-skills` commit SHA in a `VENDOR.md` next to the copy** to keep the reproducibility that
the submodule was buying (`INTEGRATION_PLAN.md:127` already asks for this).

### 5.7 Frontmatter parser — what is already available

Checked `packages/components/package.json` and `pnpm-lock.yaml`:

| Package        | In lockfile?                      | Declared by components?                            | Resolvable from components?                              |
| -------------- | --------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `gray-matter`  | ❌ **absent entirely**            | ❌                                                 | ❌                                                       |
| `front-matter` | ❌ absent                         | ❌                                                 | ❌                                                       |
| `js-yaml`      | ✅ **4.1.0** (also 3.14.1, 4.1.1) | only `@types/js-yaml: ^4.0.5` (`package.json:143`) | ✅ via `shamefully-hoist` → `node_modules/js-yaml@4.1.0` |
| `yaml`         | ✅ 1.10.2 / 2.x                   | ❌                                                 | ✅ (hoisted)                                             |

**Existing precedent — `packages/components/nodes/tools/OpenAPIToolkit/OpenAPIToolkit.ts:1`:**

```ts
import { load } from 'js-yaml'
```

That node compiles and ships today using `js-yaml` with only `@types/js-yaml` declared. So `js-yaml@4.1.0`
is available with **no new dependency and no lockfile change**.

**Recommendation:** split the frontmatter with a small regex (`/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/`) and
parse the captured block with `js-yaml`'s `load`, exactly as OpenAPIToolkit does. Do **not** add
`gray-matter` — it is not in the lockfile, so it would be a genuine new dependency plus a lockfile diff, in
exchange for ~15 lines of code. Optionally add `"js-yaml": "4.1.0"` to
`packages/components/dependencies` to make the reliance explicit (the version already resolves, so
`pnpm install` adds only an importer entry) — but that _is_ a lockfile change, so it is the architect's call.
Either way, use `load(...)` with the safe default schema and never `loadAll` with a custom schema.

---

## 6. Gotchas for an additive node

### 6.1 `pnpm dev` does not rebuild components

`packages/components` has **no `dev` script** (`package.json:17-25`). `packages/server/nodemon.json` watches
only `["commands", "index.ts", "src"]` with `"ext": "ts"` — i.e. only the server's own sources. Since
NodesPool loads from `dist/nodes`, **editing a node changes nothing until you run
`pnpm --filter flowise-components build` and restart the server.** Budget for that loop.

### 6.2 False-green builds

Three ways `pnpm build` can pass while the feature is broken:

1. **`tsc && gulp` never touches Markdown.** A green build says _nothing_ about whether skill files are
   reachable from `dist`. Only the `node -e` check in §5.4 proves it.
2. **Turbo cache.** `turbo run build` will print `FULL TURBO` and skip the package entirely on a cache hit.
   When in doubt use `pnpm build-force` (`pnpm clean && turbo run build --force`).
3. **`tsc` does not prune `dist`.** Renamed/deleted node files leave orphan `.js` in `dist/nodes` that
   NodesPool keeps loading — you can end up debugging a node that no longer exists in source. Fix with
   `pnpm --filter flowise-components clean`.

### 6.3 Lint will run before build in CI — and it lints Markdown

`.github/workflows/main.yml:32-37` runs `pnpm install` → **`pnpm lint`** → `pnpm build` → `pnpm test:coverage`.
Root lint glob (`package.json:32`) is `"**/*.{js,jsx,ts,tsx,json,md}"` — **`.md` included**.

`.eslintrc.js`:

```text
    extends: ['eslint:recommended', 'plugin:markdown/recommended', ..., 'plugin:prettier/recommended'],
    ignorePatterns: ['**/node_modules', '**/dist', '**/build', '**/coverage', '**/package-lock.json'],
    rules: {
        'no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'warn',
        'no-console': [process.env.CI ? 'error' : 'warn', { allow: ['warn', 'error', 'info'] }],
        'prettier/prettier': 'error',
        'no-control-regex': 0
    }
```

`.prettierignore` contains exactly one line: `pnpm-lock.yaml`.

Consequences for **24 vendored `SKILL.md` files**:

-   `plugin:markdown/recommended` extracts fenced code blocks and lints them with `eslint:recommended`. Skill
    files contain illustrative/pseudo-code fences; a fence tagged ```js that is not parseable JS is a **lint
    error**, not a warning.
-   `prettier/prettier: 'error'` applies Flowise's prettier config (`package.json:125-133`: printWidth 140,
    singleQuote, tabWidth 4, no semicolons, trailingComma none, `endOfLine: 'auto'`) to the Markdown too.
    Any list-marker or emphasis-character difference from prettier's canonical form is a **lint error**.
-   Running `pnpm format` would silently **rewrite the vendored files**, damaging attribution fidelity.

**Mitigation** (two one-line edits to existing files — small, defensible, and the only non-additive change
this whole feature needs):

```text
// .eslintrc.js
ignorePatterns: ['**/node_modules', '**/dist', '**/build', '**/coverage', '**/package-lock.json',
                 'packages/components/skills-library/**'],
```

```
# .prettierignore
pnpm-lock.yaml
packages/components/skills-library/**
```

I could not run `pnpm lint` to confirm the failure empirically. Run it **before** committing the vendored
files and again after, so you know which of the two ignores you actually need.

`no-console` is `'error'` under CI with only `warn`/`error`/`info` allowed — **use `console.warn` /
`console.info`, never `console.log`,** in the new node.

Components-local lint (`packages/components/package.json:19`) is
`eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0` — `--max-warnings 0` turns
`unused-imports/no-unused-imports` (a warning) into a failure. No stray imports.

### 6.4 TypeScript strictness

`strict: true` with two relaxations: `strictPropertyInitialization: false` (so the bare
`label: string; name: string; …` field declarations in every node compile) and
`useUnknownInCatchVariables: false` (so `catch (e) { e.message }` compiles). Everything else is on:
`strictNullChecks`, `noImplicitAny`, etc. `nodeData.inputs?.foo` is `any`, so cast at the boundary as the
reference node does. `skipLibCheck: true` and `declaration: true` — note the latter means your public types
must be nameable, so avoid returning anonymous complex types from exported functions.

### 6.5 Icon conventions

-   File sits **beside** the node's `.ts`, and `this.icon` is the **bare filename** (`NodesPool.ts:57-60`).
-   Extension must be `.svg`, `.png` or `.jpg` — matched with `.endsWith`, so **case-sensitive**
    (`NodesPool.ts:52-55`, `controllers/node-icons/index.ts:19`).
-   No naming convention is enforced. Existing tool icons include `calculator.svg`, `currentDateTime.svg`,
    `retrievertool.svg`, `jsonpathextractor.svg`, `chatflowTool.svg`, `google-calendar.svg`, `SearXNG.svg` —
    all-lowercase, camelCase and kebab-case all appear. **The only hard rule is that the string in
    `this.icon` matches the filename byte-for-byte** (Linux/Docker are case-sensitive even though your dev
    Windows box is not).
-   No fixed size. `calculator.svg` is `width="32" height="32" viewBox="0 0 32 32"`;
    `jsonpathextractor.svg` is `viewBox="0 0 24 24"` with no width/height. Either works — it is served as an
    `<img src>`, so `fill="currentColor"` renders as black; prefer explicit colours.
-   ⚠️ The icon reaches the UI **only via gulp**. If `pnpm --filter flowise-components build` ran `tsc` but
    the gulp step was skipped or cached oddly, the node appears with a broken image.

### 6.6 Circular-import hazards

-   `packages/components/src/Interface.ts:3` imports `../nodes/moderation/Moderation` — `src` already depends
    on `nodes`. Adding `src/skills/*` that imports from `nodes/tools/AgentSkills/*` would close a cycle.
    **Keep the registry/parser inside `nodes/tools/AgentSkills/` and import only _from_ `src`, never the
    other way.** That also avoids touching `src/index.ts`, which is the public barrel of
    `flowise-components` consumed by `packages/server` — widening it is a bigger blast radius than the
    feature needs. (`INTEGRATION_PLAN.md:37` proposes `packages/components/src/skills/`; see §7.)
-   Jest can still find colocated tests: `jest.config.js:4` is `roots: ['<rootDir>/nodes', '<rootDir>/src']`,
    and there are two existing precedents under `nodes/tools/`
    (`JSONPathExtractor.test.ts`, `AWSDynamoDBKVStorage.test.ts`).
-   Do **not** import from `nodes/tools/MCP/core` (or `flowise-components/nodes`) — it pulls in the ESM-only
    `@modelcontextprotocol/sdk`, which is explicitly stubbed for Jest (`jest.config.js:14-20`) and would
    break your unit tests.
-   `src/index.ts:4-5` calls `dotenv.config()` at import time against `path.join(__dirname, '..', '..', '.env')`.
    Importing the barrel from a node has side effects; import the specific module
    (`'../../../src/Interface'`, `'../../../src/utils'`) as every existing node does.

### 6.7 Packaging

`packages/components/package.json` has **no `files` field** and there is **no `.npmignore`**, so a
package-root `skills-library/` would be included in `npm pack`. Publishing is out of scope
(`MASTER_PROMPT.md:84`), but this means the layout is not a dead end if that changes.

---

## 7. Corrections to `MASTER_PROMPT.md` and `docs/INTEGRATION_PLAN.md`

For the integration-architect. Ordered by consequence.

### ❌ WRONG — `INTEGRATION_PLAN.md:120`: "Tool names are already sanitized by Flowise to `[a-z0-9_-]`, capped at 64 chars"

Not for tools returned by Tool nodes. `sanitizeToolName` (`Agent.ts:84`) is module-private and is called at
exactly four sites, all knowledge-base retriever tools (`Agent.ts:791,805,863,877`). The MCP sanitiser
(`MCP/core.ts:60`) is MCP-only and unsafe to import (drags in the ESM-only MCP SDK, stubbed in jest).
**The Agent Skills node must sanitise and de-duplicate its own 24 tool names.** Full evidence in §3.7.

### ⚠️ INCOMPLETE — `INTEGRATION_PLAN.md:67-71`: "Flowise has its OWN class of the same name in `nodes/tools/CustomTool/core.ts`"

There are **two** eval-running `DynamicStructuredTool` classes, not one. The second is
`packages/components/nodes/tools/OpenAPIToolkit/core.ts:124`, whose `_call` runs
`executeJavaScriptCode(this.customCode || defaultCode, sandbox)` at line 256. Eight Tools-category nodes
extend it (Gmail, GoogleCalendar, GoogleDocs, GoogleDrive, GoogleSheets, Jira, MicrosoftOutlook,
MicrosoftTeams). The plan's ban list must name both paths. `MASTER_PROMPT.md:147-149` has the same gap.
Full evidence in §3.1.

### ⚠️ CHANGE — `INTEGRATION_PLAN.md:123`: "Reference node — use `Calculator` or `RetrieverTool`"

Both are eval-free, so the plan is not _unsafe_ — but neither is the best copy target. `Calculator` (31
lines) has no inputs, no schema and no tool class of its own. `RetrieverTool` carries 90 lines of
redeclared `DynamicStructuredTool` plumbing (lines 21-117) that we would be copying for nothing.
**Use `packages/components/nodes/tools/JSONPathExtractor/JSONPathExtractor.ts`** — justification in §3.5.

### ⚠️ CHANGE — `MASTER_PROMPT.md:57`: `SKILLS_VENDOR_MODE = submodule`

Recommend **`copy`**. A clone without `--recurse-submodules` yields an empty skills directory and a node
that silently exposes zero tools; `git archive` and the patch fallback (`MASTER_PROMPT.md:196`) lose the
content outright; turbo's gitlink hashing does not track skill edits. Detail in §5.6. This is a Config
value change, so per ground rule 9 the architect/user must make the call, not the implementer.

### ⚠️ RECONSIDER — `INTEGRATION_PLAN.md:37`: "Location: `packages/components/src/skills/`"

Legal, but it costs more than it buys. `src/Interface.ts:3` already imports from `nodes/`, so putting
skills code in `src/` risks a cycle, and anything reachable from `src/index.ts` widens the public surface
of `flowise-components` (imported by `packages/server`). **Put `parser.ts` / `registry.ts` / `types.ts`
inside `packages/components/nodes/tools/AgentSkills/`** — jest still finds colocated tests
(`jest.config.js:4`), and `src/index.ts` stays untouched. Detail in §6.6.

### ⚠️ INCOMPLETE — required-field lists in both docs

Both docs enumerate `label, name, type, icon, category, baseClasses, inputs`. Per
`Interface.ts:128-148` + `150-164` the truth is: **required = `label, name, type, icon, version, category,
baseClasses`** (`version: number` is required and missing from both docs); **`inputs` and `description`
are optional**; and **`author` must be omitted** or the node is hidden unless
`appConfig.showCommunityNodes` is on (`NodesPool.ts:73-76`). Detail in §2.3.

### ⚠️ ADD — nothing in either doc mentions the Markdown lint hazard

CI runs `pnpm lint` **before** `pnpm build` (`main.yml:32-34`), the root lint glob includes `**/*.md`, and
`plugin:markdown/recommended` + `prettier/prettier: 'error'` will be applied to all 24 vendored skill
files. `.prettierignore` is one line long. This is the most likely way this change turns CI red. Detail
and the two-line mitigation in §6.3.

### ⚠️ ADD — `docker/Dockerfile` cannot carry this change

`docker/Dockerfile:19` is `RUN npm install -g flowise` — it installs the published package, it does not
build local source. Any plan step that assumes a Docker image would demonstrate the fork's node is wrong.

### ✅ CONFIRMED CORRECT (no action)

-   `MASTER_PROMPT.md:22-24` / `INTEGRATION_PLAN.md:18-19` — six packages; `node ^24`, `pnpm ^10.26.0`; version 3.1.4.
-   `INTEGRATION_PLAN.md:112-114` — `class X_Tools implements INode`, `category = 'Tools'`,
    `baseClasses = [this.type, 'Tool']`, return the tool from `init()`, `module.exports = { nodeClass: X_Tools }`.
-   `INTEGRATION_PLAN.md:115-117` — discovery is automatic, `NodesPool` scans `dist/nodes` for `.js` exporting
    `nodeClass`, no index file to edit, relative `icon` rewritten to an absolute path at load (§4.1, §4.2).
-   `INTEGRATION_PLAN.md:118-119` — one node may return an array of tools; `Agent.ts:722` `Array.isArray`
    branch, plus `Tool.ts:152/283` and `ToolAgent.ts:269 flatten(tools)` (§3.6).
-   `INTEGRATION_PLAN.md:70-71` / `MASTER_PROMPT.md:147-149` — `CurrentDateTime` imports
    `DynamicStructuredTool` from `../CustomTool/core`. **Verbatim confirmed** at `CurrentDateTime.ts:3` (§3.2).
-   `MASTER_PROMPT.md:151-153` — gulp copies only `{jpg,png,svg}`; Markdown is not copied; resolve from
    `__dirname` at runtime; the package root **is** reachable from `dist/nodes/tools/...` (§5.2, §5.4).
-   New: the `models.json` / `modelLoader.ts:12-20` precedent proves the `__dirname` probe approach works in
    production, which closes `INTEGRATION_PLAN.md:129-130` in favour of "resolve from `__dirname`", not
    "extend `gulpfile.ts`".
-   **`gray-matter` is not in the lockfile; `js-yaml@4.1.0` is available** with an in-tree precedent at
    `OpenAPIToolkit.ts:1` (§5.7). `MASTER_PROMPT.md:143` suggests `gray-matter` "matching Flowise's deps" —
    it does not match; `js-yaml` does.

---

## 8. Copy-paste-ready checklist — how to add a new Tool node

```
packages/components/nodes/tools/AgentSkills/
├── AgentSkills.ts        # the node  (copy JSONPathExtractor.ts)
├── agentskills.svg       # icon, filename must match this.icon byte-for-byte
├── parser.ts             # SKILL.md frontmatter + body  (js-yaml)
├── registry.ts           # discover + index + cache, never throws
├── types.ts
└── AgentSkills.test.ts   # jest picks this up via roots: ['<rootDir>/nodes', ...]

packages/components/skills-library/     # vendored copy, package ROOT (not under nodes/, not under src/)
├── LICENSE               # agent-skills MIT, verbatim
├── VENDOR.md             # upstream repo URL + exact commit SHA
└── skills/<name>/SKILL.md   × 24
```

1. **Create the directory** `packages/components/nodes/tools/AgentSkills/`.
2. **Copy `JSONPathExtractor.ts` as the skeleton.** Keep its import block, its
   `class …Tool extends StructuredTool` shape, its `class …_Tools implements INode`, and its final
   `module.exports = { nodeClass: … }`.
3. **Set the required `INodeProperties`** in the constructor: `label`, `name` (camelCase, unique across all
   nodes — this is the REST key and the `DISABLED_NODES` key), `version` (`1.0`), `type`, `icon`
   (bare filename), `category = 'Tools'`, `baseClasses`. Include `'Tool'` in `baseClasses` so the classic
   `ToolAgent` socket accepts it. **Do not set `author`.**
4. **Import the tool base class from `@langchain/core/tools` only.** Never
   `../CustomTool/core`, never `../OpenAPIToolkit/core`. Use `import { z } from 'zod/v3'`.
5. **Declare `inputs: INodeParams[]`** — required keys per param are `label`, `name`, `type` only.
6. **Implement `init(nodeData: INodeData, _: string, options?: ICommonObject): Promise<any>`.** Read config
   as `nodeData.inputs?.<name>` and cast. Return the tool, or `Tool[]` for one-tool-per-skill — both are
   supported (`Agent.ts:722`, `Tool.ts:152`, `ToolAgent.ts:269`). Do **not** implement `run()`.
7. **Do all file I/O lazily inside `init()`.** A top-level throw is swallowed by `NodesPool.ts:84-86` and
   the node just disappears from the palette.
8. **Resolve the skills dir with a `__dirname` probe list** (dev = 3 up, built = 4 up) modelled on
   `src/modelLoader.ts:12-20`. Never assume one depth.
9. **Sanitise your own tool names** — `.toLowerCase().replace(/ /g,'_').replace(/[^a-z0-9_-]/g,'').slice(0,64)`
   plus collision de-duplication. Flowise will not do it for you (§3.7). Precedent:
   `RequestsGet.ts:129`.
10. **Add the icon** as `.svg`/`.png`/`.jpg` beside the `.ts`, filename identical to `this.icon`.
    Gulp copies it (`gulpfile.ts:4`); nothing else does.
11. **Vendor the skills at the components package root**, not under `nodes/` (gulp would ignore them
    anyway) and not under `src/` (tsc would try to compile the directory's neighbours).
12. **Add the vendored path to `.eslintrc.js` `ignorePatterns` and `.prettierignore`** if `pnpm lint`
    flags the Markdown (§6.3). Verify by running `pnpm lint` before and after.
13. **Use `console.warn` / `console.info` / `console.error`.** `console.log` fails CI lint (`no-console`
    is `'error'` when `process.env.CI`).
14. **No index file to edit. No UI change. No credential.** Discovery is `NodesPool.ts:26-31`; the palette
    groups on `category` (`AddNodes.jsx:266`); the Agent tool picker sweeps `category === 'Tools'`
    (`Agent.ts:618`).
15. **Build and prove it from the BUILT tree:**
    ```powershell
    cd "C:\Users\bruger1\Desktop\ACLA Agents\flowise-fork"
    pnpm --filter flowise-components clean
    pnpm --filter flowise-components build
    dir packages\components\dist\nodes\tools\AgentSkills          # expect .js, .d.ts, .js.map, .svg
    node -e "const m=require('./packages/components/dist/nodes/tools/AgentSkills/AgentSkills.js'); const n=new m.nodeClass(); n.init({id:'t',inputs:{}},'',{}).then(t=>console.log(Array.isArray(t)?t.length+' tools':'1 tool')).catch(e=>{console.error(e);process.exit(1)})"
    ```
16. **Then the whole tree, then the server:**
    ```powershell
    pnpm lint
    pnpm build
    pnpm --filter flowise-components test
    pnpm start          # http://localhost:3000 -> palette -> Tools -> "Agent Skills"
    ```
    If `pnpm build` prints `FULL TURBO`, rerun with `pnpm build-force` before trusting it.
17. **Machine-check ground rule 8** before review (`MASTER_PROMPT.md:190-192`):
    ```powershell
    Select-String -Path "packages\components\nodes\tools\AgentSkills\*.ts" -Pattern "executeJavaScriptCode|eval\(|new Function|child_process|CustomTool/core|OpenAPIToolkit/core"
    ```
    Expect **zero** matches.
