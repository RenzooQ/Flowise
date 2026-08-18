import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import * as path from 'node:path'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { wrapSkillBody } from './envelope'
import { capDescription, extractSection } from './parser'
import { getSkillIndex, loadSkillBody, loadSkillReference } from './registry'
import { SkillMeta } from './types'

/**
 * Agent Skills - one LangChain tool per Markdown skill.
 *
 * The tool base class is `StructuredTool` from `@langchain/core/tools`, and that is the only
 * permitted one. Two sibling `core` modules in this tree - one under CustomTool, one under
 * OpenAPIToolkit - export a class with the SAME name whose `_call` runs arbitrary JavaScript;
 * 14 Tools-category nodes extend the latter. Importing from either is forbidden here, and nothing
 * in this subsystem ever evaluates, compiles or executes skill content. A skill is instruction
 * text returned to the model, delimited as untrusted reference material.
 *
 * That rule is machine-checked: a grep over this directory for the banned identifiers and import
 * paths must return zero matches, so this comment deliberately does not spell them out literally.
 */

/** Combined description budget above which the node suggests selecting a subset. */
const DESCRIPTION_BUDGET_WARNING_CHARS = 20_000

/**
 * The argument schema for one skill's tool.
 *
 * Built per skill rather than shared, because the `reference` description names that skill's own
 * companion files. A model told exactly which values are legal picks one of them; a model told only
 * that "a reference" exists guesses filenames that do not exist.
 *
 * Every property is `required`, which OpenAI strict mode demands, so both are always sent and an
 * empty string is the "not asking for this" value.
 */
const buildSchema = (meta: SkillMeta) =>
    z.object({
        section: z
            .string()
            .describe(
                'Required. Pass an empty string "" to load the complete skill - that is the normal case. ' +
                    'Or pass a single heading, e.g. "Verification", to return only that section of the skill; ' +
                    'if that heading is absent the complete skill is returned instead.'
            ),
        reference: z
            .string()
            .describe(
                meta.references.length
                    ? 'Required. Pass an empty string "" for the skill itself - that is the normal case. ' +
                          'This skill also cites companion documents; pass one of these exact names to load it ' +
                          `instead of the skill body: ${meta.references.join(', ')}. Load the skill first, then a ` +
                          'companion only if the skill tells you to consult it.'
                    : 'Required. Always pass an empty string "" - this skill cites no companion documents.'
            )
    })

/** One skill, exposed as one callable tool. */
class AgentSkillTool extends StructuredTool {
    name: string
    description: string

    schema: ReturnType<typeof buildSchema>

    private readonly meta: SkillMeta
    private readonly skillsDir: string

    constructor(meta: SkillMeta, skillsDir: string) {
        super()
        this.meta = meta
        this.skillsDir = skillsDir
        this.schema = buildSchema(meta)
        this.name = meta.toolName
        // Verbatim frontmatter description. The "Use when ..." clause is the selection mechanism the
        // whole design rests on, so nothing is prepended, appended or rewritten. The "this is
        // reference text" framing lives in the return value, where the model needs it, rather than
        // here, where it would dilute trigger matching and eat the 1024-char budget.
        this.description = capDescription(meta.description)
    }

    /**
     * Fill in any argument the model left out, then hand over to the normal validating path.
     *
     * Both properties are `required` in the schema because OpenAI strict mode demands that
     * `required` list every property. Strict mode then guarantees they are sent — but nothing
     * outside strict mode does, and `StructuredTool.call` validates before `_call` runs, so a single
     * omitted key does not degrade one argument: it throws "Received tool input did not match
     * expected schema" and takes down the whole agent run.
     *
     * That is not hypothetical. Adding `reference` broke the end-to-end run immediately, because the
     * caller sent only `section`. The same exposure already existed for `section` alone; a second
     * property simply doubled the chance of hitting it.
     *
     * Defaults are applied here rather than in the schema deliberately. Making the properties
     * optional in Zod would drop them from `required` in the emitted JSON Schema, which is exactly
     * what strict mode rejects. This keeps the schema strict for the model and forgiving at runtime.
     */
    async call(arg: any, configArg?: any, tags?: any): Promise<any> {
        const withDefaults = arg && typeof arg === 'object' && !Array.isArray(arg) ? { section: '', reference: '', ...arg } : arg
        return super.call(withDefaults, configArg, tags)
    }

    async _call({ section, reference }: z.infer<typeof this.schema>): Promise<string> {
        // A companion document is a different file, so it short-circuits the body path entirely.
        // Anything not in this skill's own cited set throws, and the message lists what IS available
        // rather than only refusing — a model that guessed a filename can then pick a real one.
        const wantedReference = (reference ?? '').trim()
        if (wantedReference) {
            const text = await loadSkillReference(this.meta, this.skillsDir, wantedReference)
            return wrapSkillBody(this.meta.toolName, `references/${wantedReference.toLowerCase()}`, text)
        }

        const body = await loadSkillBody(this.meta)

        // Blank means "the whole skill", which is the forced default: no heading is present in all
        // 24 vendored files and `## Process` is exactly 1 of 24 as an exact H2.
        //
        // `section` is a REQUIRED property (see the schema above), so StructuredTool.call rejects a
        // missing key before this runs and `?? ''` cannot fire today. It is kept deliberately: the
        // property is required only to satisfy OpenAI strict mode, which demands that `required`
        // list every property, and a future relaxation of that would make undefined reachable again.
        const wanted = (section ?? '').trim()
        const payload = wanted ? extractSection(body, wanted) : body

        const source = path.relative(this.skillsDir, this.meta.absolutePath).split(path.sep).join('/')
        return wrapSkillBody(this.meta.toolName, source || path.basename(this.meta.absolutePath), payload)
    }
}

class AgentSkills_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Agent Skills'
        this.name = 'agentSkills'
        this.version = 1.0
        this.type = 'AgentSkills'
        this.icon = 'agentskills.svg'
        this.category = 'Tools'
        this.description =
            "Load Markdown agent skills as tools. Each selected skill becomes one tool that returns that skill's instructions as quoted, untrusted reference text."
        // Literally ['AgentSkills', 'Tool'], NOT getBaseClasses(AgentSkillTool): that walks the
        // prototype chain by class name and yields ['StructuredTool','Runnable'], never the literal
        // 'Tool' that the classic ToolAgent socket requires. OpenAPIToolkit.ts:121 does the same.
        this.baseClasses = [this.type, 'Tool']
        this.inputs = [
            {
                label: 'Skill Selection',
                name: 'skillSelection',
                type: 'options',
                options: [
                    { label: 'All Skills', name: 'all' },
                    { label: 'Selected Skills', name: 'selected' }
                ],
                default: 'all',
                description: 'Expose every skill in the directory, or pick a subset.'
            },
            {
                label: 'Skills',
                name: 'selectedSkills',
                type: 'asyncMultiOptions',
                loadMethod: 'listSkills',
                refresh: true,
                optional: true,
                show: { skillSelection: 'selected' },
                description: 'Each selected skill becomes one tool the agent can call.'
            },
            {
                label: 'Skills Directory',
                name: 'skillsDirectory',
                type: 'string',
                optional: true,
                additionalParams: true,
                placeholder: 'C:\\path\\to\\skills   (leave empty for the bundled skills)',
                description:
                    'Absolute path to a directory laid out as <dir>/<skill-name>/SKILL.md. Leave empty to use the 24 skills bundled with Flowise.',
                warning:
                    'Trust boundary: the text in these files is delivered to the agent as instructions. Anyone who can write to this directory can steer any agent this node is attached to, including which tools it calls and with what arguments. Only point this at a directory you control.'
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        /**
         * Populate the Skills multi-select.
         *
         * Must NEVER throw: `packages/server/src/services/nodes/index.ts:119-120` swallows the error
         * and returns [], so a throw is indistinguishable from an empty list and loses the diagnostic.
         */
        listSkills: async (nodeData: INodeData, _options?: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const index = await getSkillIndex(nodeData.inputs?.skillsDirectory as string)
                if (!index.skills.length) {
                    console.warn(`[AgentSkills] no skills found in "${index.skillsDir || '(unresolved)'}"`)
                    return []
                }
                return index.skills.map((skill) => ({
                    label: skill.title || skill.name,
                    // The stored value is the FOLDER, the catalog's primary key.
                    name: skill.folder,
                    description: skill.description.slice(0, 140)
                }))
            } catch (error) {
                console.error(`[AgentSkills] listSkills failed: ${error instanceof Error ? error.message : error}`)
                return []
            }
        }
    }

    async init(nodeData: INodeData, _: string): Promise<any> {
        const skillsDirectory = (nodeData.inputs?.skillsDirectory as string) || ''
        const skillSelection = (nodeData.inputs?.skillSelection as string) || 'all'

        const index = await getSkillIndex(skillsDirectory)

        if (!index.skills.length) {
            // A visible flow error beats an agent that silently holds no tools.
            // Mirrors JSONPathExtractor.ts:118.
            throw new Error(
                `Agent Skills: no skills found in "${index.skillsDir || skillsDirectory}". Expected <dir>/<skill-name>/SKILL.md.`
            )
        }

        let chosen: SkillMeta[] = index.skills
        if (skillSelection === 'selected') {
            // An asyncMultiOptions value arrives either as a JSON string or as an array
            // (the OpenAPIToolkit.ts:166-174 idiom).
            const raw = nodeData.inputs?.selectedSkills
            let selected: string[] = []
            if (raw) {
                try {
                    selected = typeof raw === 'string' ? JSON.parse(raw) : (raw as string[])
                } catch (e) {
                    selected = []
                }
            }
            if (!Array.isArray(selected)) selected = []

            const byFolder = new Map(index.skills.map((skill) => [skill.folder, skill]))
            chosen = []
            // De-duplicate: the multi-select UI cannot produce repeats, but an imported flow JSON, a
            // marketplace template or an API-created chatflow can. Two tools with one name is not a
            // cosmetic problem - OpenAI and Anthropic both reject the request outright, so a single
            // duplicated entry would fail every run of the whole agent, not just one call.
            const seenFolders = new Set<string>()
            for (const folder of selected) {
                if (seenFolders.has(folder)) continue
                seenFolders.add(folder)
                const skill = byFolder.get(folder)
                if (!skill) {
                    // The user may have edited the skills directory since selecting. Warn and skip.
                    console.warn(`[AgentSkills] selected skill "${folder}" is not in "${index.skillsDir}"; skipped`)
                    continue
                }
                chosen.push(skill)
            }

            if (!chosen.length) {
                throw new Error('Agent Skills: "Selected Skills" is set but no valid skill was selected. Pick at least one skill.')
            }
        }

        const descriptionChars = chosen.reduce((total, skill) => total + capDescription(skill.description).length, 0)
        if (descriptionChars > DESCRIPTION_BUDGET_WARNING_CHARS) {
            console.warn(
                `[AgentSkills] the ${chosen.length} selected skills contribute ${descriptionChars} characters of tool descriptions to every prompt; consider selecting a subset`
            )
        }
        for (const skill of chosen) {
            if (skill.description.length > capDescription(skill.description).length) {
                console.warn(`[AgentSkills] description for "${skill.folder}" exceeded 1024 characters and was truncated`)
            }
        }

        return chosen.map((skill) => new AgentSkillTool(skill, index.skillsDir))
    }
}

module.exports = { nodeClass: AgentSkills_Tools }
