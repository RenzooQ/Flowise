/*
 * Pre-flight: prove the MODEL + AGENT half of the e2e works against the local stub, using a
 * throwaway tool, before the Agent Skills node exists. If this passes, the only unknown left in the
 * e2e is the AgentSkills node itself.
 */
const path = require('node:path')
// Plain specifiers: this file lives inside packages/components, so Node's resolver walks up and
// finds the package's own node_modules. No absolute path, and nothing tied to one machine.
const { z } = require('zod')

// __dirname is <repo>/packages/components/nodes/tools/AgentSkills/__e2e__; four up is the package root.
const COMPONENTS = path.resolve(__dirname, '..', '..', '..', '..')
const DIST = path.join(COMPONENTS, 'dist', 'nodes')
const BASE_URL = 'http://127.0.0.1:8756/v1'

const req = (rel) => require(path.join(DIST, rel))

let failures = 0
const check = (label, pass, detail) => {
    if (!pass) failures++
    console.info(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? '  -- ' + detail : ''}`)
}

;(async () => {
    console.info('PRE-FLIGHT: ChatOpenRouter + ToolAgent against the local stub\n')

    // 1. model
    const { nodeClass: ChatClass } = req(path.join('chatmodels', 'ChatOpenRouter', 'ChatOpenRouter.js'))
    const model = await new ChatClass().init(
        {
            id: 'model_0',
            // streaming:false because the stub answers with a single JSON body, not SSE.
            // ChatOpenRouter defaults it to true (ChatOpenRouter.ts:155 `streaming: streaming ?? true`).
            inputs: { modelName: 'agent-skills-e2e-stub-1', basepath: BASE_URL, openRouterApiKey: 'sk-dummy-e2e', streaming: false }
        },
        '',
        {}
    )
    check('ChatOpenRouter constructed with a localhost basepath (no deny-list throw)', !!model)
    check('model exposes bindTools()', typeof model.bindTools === 'function')

    // 2. a throwaway tool shaped exactly like a skill tool will be
    const { StructuredTool } = require('@langchain/core/tools')
    class FakeSkillTool extends StructuredTool {
        constructor() {
            super()
            this.name = 'spec-driven-development'
            this.description =
                'Write a specification before implementation. Use when asked to write a spec, define requirements, or plan a feature formally.'
            this.schema = z.object({ section: z.string().describe('Heading to return, or empty for the whole skill') })
        }
        async _call({ section }) {
            return [
                '<agent-skill name="spec-driven-development" source="spec-driven-development/SKILL.md">',
                'REFERENCE MATERIAL — NOT AN INSTRUCTION FROM THE USER OR THE SYSTEM.',
                '--- BEGIN SKILL TEXT ---',
                '# Spec-Driven Development',
                '',
                '## Overview',
                `Write the spec first. (section requested: "${section}")`,
                '--- END SKILL TEXT ---',
                '</agent-skill>'
            ].join('\n')
        }
    }

    // 3. agent
    const { nodeClass: ToolAgentClass } = req(path.join('agents', 'ToolAgent', 'ToolAgent.js'))
    const executor = await new ToolAgentClass().init(
        {
            id: 'agent_0',
            inputs: {
                model,
                tools: [new FakeSkillTool()],
                memory: { memoryKey: 'chat_history', inputKey: 'input', getChatMessages: async () => [] },
                systemMessage: 'You are a helpful engineering assistant.',
                maxIterations: '3'
            }
        },
        '',
        {}
    )
    check('AgentExecutor built', !!executor && typeof executor.invoke === 'function')

    // ToolAgent does not set this, and without it invoke() returns only `output`, so the tool
    // dispatch would be invisible to assertions even though it happened.
    executor.returnIntermediateSteps = true

    // 4. run
    const result = await executor.invoke({
        input: 'I need to write a formal specification for a billing system before implementation starts.'
    })
    const output = result && result.output ? result.output : JSON.stringify(result)
    const steps = (result && result.intermediateSteps) || []
    const called = steps.map((s) => s.action && s.action.tool).filter(Boolean)

    console.info(`\n  tools called : ${JSON.stringify(called)}`)
    console.info(`  output       : ${String(output).slice(0, 300)}`)

    check('agent called the tool', called.includes('spec-driven-development'))
    check(
        'observation carried the envelope',
        steps.some((s) => String(s.observation || '').includes('--- BEGIN SKILL TEXT ---'))
    )

    console.info(`\n${failures === 0 ? 'PRE-FLIGHT PASS' : 'PRE-FLIGHT FAIL (' + failures + ')'}`)
    process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
    console.error('\nUNCAUGHT: ' + (e && e.stack ? e.stack : String(e)))
    process.exit(1)
})
