import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import * as path from 'node:path'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { wrapSkillBody } from './envelope'
import { capDescription, extractSection } from './parser'
import { getSkillIndex, loadSkillBody } from './registry'
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

/** One skill, exposed as one callable tool. */
class AgentSkillTool extends StructuredTool {
    name: string
    description: string

    schema = z.object({
        section: z
            .string()
            .describe(
                'Optional heading to return instead of the whole skill, e.g. "Verification". ' +
                    'Falls back to the complete skill if the heading is absent. ' +
                    'Pass an empty string to load the complete skill (recommended).'
            )
    })

    private readonly meta: SkillMeta
    private readonly skillsDir: string

    constructor(meta: SkillMeta, skillsDir: string) {
        super()
        this.meta = meta
        this.skillsDir = skillsDir
        this.name = meta.toolName
        // Verbatim frontmatter description. The "Use when ..." clause is the selection mechanism the
        // whole design rests on, so nothing is prepended, appended or rewritten. The "this is
        // reference text" framing lives in the return value, where the model needs it, rather than
        // here, where it would dilute trigger matching and eat the 1024-char budget.
        this.description = capDescription(meta.description)
    }

    async _call({ section }: z.infer<typeof this.schema>): Promise<string> {
        const body = await loadSkillBody(this.meta)

        // Blank means "the whole skill", which is the forced default: no heading is present in all
        // 24 vendored files and `## Process` is exactly 1 of 24 as an exact H2.
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
            for (const folder of selected) {
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
