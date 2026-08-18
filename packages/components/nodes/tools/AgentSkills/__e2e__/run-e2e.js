/*
 * Agent Skills — end-to-end test, driven through the REAL Flowise node classes, loaded from dist/.
 *
 * Chain under test (all three are genuine Flowise nodes, required out of the BUILT tree):
 *     ChatOpenRouter  ->  ToolAgent (AgentExecutor)  <-  AgentSkills (24 tools)
 *
 * The model endpoint is a local deterministic OpenAI-compatible stub (see ../stubmodel/server.js).
 * It is used because no LLM API key exists on this machine and the Claude-subscription bridges wrap
 * the Claude Code agent CLI, which ignores caller-supplied `tools` (measured).
 *
 * PROVES: Flowise serialises all 24 skills as tool definitions carrying their frontmatter
 * descriptions; the Agent dispatches the selected skill tool; the AgentSkills node returns the
 * enveloped skill body; the body re-enters the model context and reaches the final answer.
 *
 * DOES NOT PROVE: that a production LLM elects to call a skill unprompted. Selection in the stub is
 * deterministic lexical scoring, not model judgement.
 *
 * Usage:  node run-e2e.js [stubPort]
 */
const path = require('node:path')
const fs = require('node:fs')

// Resolved from this file's own location, so the harness runs from any checkout on any host.
// __dirname is <repo>/packages/components/nodes/tools/AgentSkills/__e2e__; four levels up is the
// components package root, which is the only root anything below needs.
const COMPONENTS = path.resolve(__dirname, '..', '..', '..', '..')
const DIST = path.join(COMPONENTS, 'dist', 'nodes')
const SKILLS_LIBRARY = path.join(COMPONENTS, 'skills-library', 'skills')
const STUB_PORT = Number(process.argv[2] || 8756)
const BASE_URL = `http://127.0.0.1:${STUB_PORT}/v1`
const EVIDENCE = path.join(__dirname, 'evidence.txt')

const lines = []
const say = (s) => {
    console.info(s)
    lines.push(s)
}
const finish = (code) => {
    // Relative, so the committed evidence file does not record one machine's directory layout.
    say(`\nEvidence written to ${path.relative(COMPONENTS, EVIDENCE).split(path.sep).join('/')}`)
    fs.writeFileSync(EVIDENCE, lines.join('\n') + '\n', 'utf8')
    // Set the code and let the loop drain rather than calling process.exit(). Tearing the process
    // down while the HTTP agent still holds sockets trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`), which replaced the real exit status with 127 and
    // would make this harness unusable as a CI gate.
    process.exitCode = code
    if (typeof globalThis.fetch === 'function') {
        // Node keeps the undici agent's sockets alive; without this the drain waits for their timeout.
        const agent = globalThis[Symbol.for('undici.globalDispatcher.1')]
        if (agent && typeof agent.close === 'function') agent.close().catch(() => {})
    }
}

const req = (rel) => require(path.join(DIST, rel))

let failures = 0
const check = (label, pass, detail) => {
    if (!pass) failures++
    say(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? '  -- ' + detail : ''}`)
}

;(async () => {
    say('='.repeat(78))
    say('AGENT SKILLS — END-TO-END (real Flowise nodes, loaded from dist/)')
    say('='.repeat(78))
    say(`dist nodes root : ${path.relative(COMPONENTS, DIST).split(path.sep).join('/')}  (under packages/components)`)
    say(`model endpoint  : ${BASE_URL}`)
    say(`run at          : ${new Date().toISOString()}`)

    // ---------------------------------------------------------------- 1. AgentSkills -> tools
    say('\n1. AgentSkills node — build the tool array from the BUILT tree')
    const { nodeClass: AgentSkillsClass } = req(path.join('tools', 'AgentSkills', 'AgentSkills.js'))
    const skillsNode = new AgentSkillsClass()
    say(
        `   label=${skillsNode.label !== undefined ? skillsNode.label : '?'}  category=${skillsNode.category}  version=${
            skillsNode.version
        }  icon=${skillsNode.icon}`
    )
    check('category is Tools', skillsNode.category === 'Tools')
    check(
        "baseClasses contains literal 'Tool'",
        Array.isArray(skillsNode.baseClasses) && skillsNode.baseClasses.includes('Tool'),
        JSON.stringify(skillsNode.baseClasses)
    )
    check('author is omitted (node would be hidden otherwise)', skillsNode.author === undefined)

    const tools = await skillsNode.init({ id: 'skills_0', inputs: {} }, '')
    check('init() returns an array', Array.isArray(tools))
    check('exposes 24 tools', tools.length === 24, `got ${tools.length}`)
    const names = tools.map((t) => t.name)
    check('tool names are unique', new Set(names).size === names.length)
    check(
        'tool names are lowercase-safe',
        names.every((n) => /^[a-z0-9_-]{1,64}$/.test(n))
    )
    say(`   tools: ${names.slice(0, 6).join(', ')} ... (+${names.length - 6} more)`)

    const specTool = tools.find((t) => t.name === 'spec-driven-development')
    check('spec-driven-development is present', !!specTool)
    if (specTool) say(`   its description: "${String(specTool.description).slice(0, 120)}..."`)

    // ---------------------------------------------------------------- 2. ChatOpenRouter -> model
    say('\n2. ChatOpenRouter node — point it at the local stub')
    const { nodeClass: ChatClass } = req(path.join('chatmodels', 'ChatOpenRouter', 'ChatOpenRouter.js'))
    const chatNode = new ChatClass()
    const model = await chatNode.init(
        {
            id: 'model_0',
            inputs: {
                modelName: 'agent-skills-e2e-stub-1',
                basepath: BASE_URL,
                // getCredentialParam reads nodeData.inputs first, so no credential store is needed.
                openRouterApiKey: 'sk-dummy-e2e',
                // The stub answers with one JSON body, not SSE. ChatOpenRouter.ts:155 defaults
                // streaming to true, which would hand the output parser an empty generation.
                streaming: false
            }
        },
        '',
        {}
    )
    check('model constructed', !!model)
    check('model exposes bindTools()', typeof model.bindTools === 'function')

    // ---------------------------------------------------------------- 3. ToolAgent -> executor
    say('\n3. ToolAgent node — wire model + the 24 skill tools')
    const { nodeClass: ToolAgentClass } = req(path.join('agents', 'ToolAgent', 'ToolAgent.js'))
    const agentNode = new ToolAgentClass()
    const memory = {
        memoryKey: 'chat_history',
        inputKey: 'input',
        getChatMessages: async () => []
    }
    const executor = await agentNode.init(
        {
            id: 'agent_0',
            inputs: {
                model,
                tools,
                memory,
                systemMessage: 'You are a helpful engineering assistant. Use the available skills when they apply.',
                maxIterations: '3'
            }
        },
        '',
        {}
    )
    check('AgentExecutor built', !!executor && typeof executor.invoke === 'function')

    // ToolAgent does not set this. Without it invoke() returns only `output`, so the tool dispatch
    // is invisible to assertions even though it happened.
    executor.returnIntermediateSteps = true

    // ---------------------------------------------------------------- 4. run it
    const PROMPT = 'I need to write a formal specification for a billing system before any implementation starts.'
    say(`\n4. Invoking the agent`)
    say(`   prompt: "${PROMPT}"`)
    const result = await executor.invoke({ input: PROMPT })

    const output = typeof result === 'string' ? result : result && result.output ? result.output : JSON.stringify(result)
    say('\n5. Agent output')
    say('   ' + String(output).split('\n').join('\n   '))

    // ---------------------------------------------------------------- 5. assertions
    say('\n6. Assertions')
    const steps = (result && result.intermediateSteps) || []
    const calledNames = steps.map((s) => (s.action && s.action.tool) || '').filter(Boolean)
    say(`   intermediate steps: ${steps.length}; tools called: ${JSON.stringify(calledNames)}`)

    check('the agent called at least one tool', calledNames.length > 0)
    check(
        'the tool it called is one of the 24 skills',
        calledNames.every((n) => names.includes(n)),
        JSON.stringify(calledNames)
    )

    const observations = steps.map((s) => String(s.observation || '')).join('\n')
    check(
        'a skill returned the untrusted-data envelope',
        observations.includes('--- BEGIN SKILL TEXT ---') && observations.includes('--- END SKILL TEXT ---')
    )
    check('the envelope carries the REFERENCE MATERIAL framing', /REFERENCE MATERIAL/i.test(observations))
    check('the envelope names the skill', /<agent-skill name="/.test(observations))

    // The skill body must be the real vendored text, not a stub.
    if (calledNames.length) {
        const vendored = path.join(SKILLS_LIBRARY, calledNames[0], 'SKILL.md')
        if (fs.existsSync(vendored)) {
            const body = fs.readFileSync(vendored, 'utf8')
            const marker = (body.split('\n').find((l) => l.startsWith('## ')) || '').trim()
            check(`observation contains real vendored text ("${marker}")`, marker.length > 0 && observations.includes(marker))
        }
    }

    // Test that the answer is built from text that actually came back inside the envelope, rather
    // than merely that the word "skill" appears.
    //
    // The heading levels here must match what the responder extracts. The stub pulls the first
    // heading out of the envelope body with /^#{1,3}\s+(.+)$/m (stubmodel/server.js:87), i.e. H1
    // included. Scanning only for `##` here made the assertion fail whenever the selected skill's
    // first heading was its H1 title — a mismatch between the two halves of this harness, not a
    // defect in the node. Keep the two patterns in step.
    if (calledNames.length) {
        const f = path.join(SKILLS_LIBRARY, calledNames[0], 'SKILL.md')
        const heads = fs.existsSync(f)
            ? [...fs.readFileSync(f, 'utf8').matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].trim()).filter((h) => h.split(' ').length > 1)
            : []
        const echoed = heads.filter((h) => String(output).toLowerCase().includes(h.toLowerCase()))
        check(
            'the answer echoes the loaded skill instructions',
            echoed.length > 0,
            echoed.length ? 'echoed: ' + JSON.stringify(echoed.slice(0, 3)) : 'no heading from the skill appeared in the answer'
        )
    }

    // ------------------------------------------------------- 7. targeted dispatch of ONE skill
    // Case 1 shows *a* skill loads. This shows a *specific* skill loads: proof that the 24 tools are
    // individually addressable and that each returns its own file, not a shared or first-match body.
    say('\n7. Second case — targeted dispatch of a named skill')
    const executor2 = await agentNode.init(
        {
            id: 'agent_1',
            inputs: {
                model,
                tools,
                memory: { memoryKey: 'chat_history', inputKey: 'input', getChatMessages: async () => [] },
                systemMessage: 'You are a helpful engineering assistant.',
                maxIterations: '3'
            }
        },
        '',
        {}
    )
    executor2.returnIntermediateSteps = true
    const TARGET = 'test-driven-development'
    // An LLM electing to call a tool is nondeterministic, so MASTER_PROMPT.md sets the bar at
    // "3 attempts, at least 1 success". A single try would make a green run luck, not evidence.
    let steps2 = []
    let called2 = []
    let obs2 = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r2 = await executor2.invoke({
            input: `Use the ${TARGET} tool to load that skill, then follow it. Call the tool first.`
        })
        steps2 = (r2 && r2.intermediateSteps) || []
        called2 = steps2.map((s) => s.action && s.action.tool).filter(Boolean)
        obs2 = steps2.map((s) => String(s.observation || '')).join('\n')
        say(`   attempt ${attempt}: tools called ${JSON.stringify(called2)}`)
        if (called2.includes(TARGET)) break
    }
    say(`   tools called: ${JSON.stringify(called2)}`)
    check(`dispatched exactly "${TARGET}"`, called2.length === 1 && called2[0] === TARGET, JSON.stringify(called2))
    check('its envelope names that same skill', obs2.includes(`<agent-skill name="${TARGET}"`))

    // The returned body must be THAT file's text, byte-for-byte inside the envelope.
    const targetFile = path.join(SKILLS_LIBRARY, TARGET, 'SKILL.md')
    if (fs.existsSync(targetFile)) {
        const raw = fs.readFileSync(targetFile, 'utf8')
        const body = raw
            .split(/^---[ \t]*\r?\n/m)
            .slice(2)
            .join('---\n')
            .trimStart()
        const inner = (obs2.split('--- BEGIN SKILL TEXT ---')[1] || '').split('--- END SKILL TEXT ---')[0].trim()
        check(
            'returned body matches the vendored SKILL.md body byte-for-byte',
            inner === body.trim(),
            `returned ${inner.length} chars vs file ${body.trim().length}`
        )
    }

    say('\n' + '='.repeat(78))
    say(failures === 0 ? `RESULT: PASS — all assertions green` : `RESULT: FAIL — ${failures} assertion(s) failed`)
    say('='.repeat(78))
    finish(failures === 0 ? 0 : 1)
})().catch((e) => {
    say('\nUNCAUGHT ERROR: ' + (e && e.stack ? e.stack : String(e)))
    say('RESULT: FAIL')
    finish(1)
})
