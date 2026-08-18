/*
 * Rebuild the labelled dataset behind docs/SKILL-SELECTION-EVAL.md.
 *
 * That document reports 95.7% top-1 / 100% top-2 over 117 labelled prompts. The scoring run itself
 * used ten independent LLM selectors and is not deterministic, so it cannot be replayed exactly.
 * Everything it was computed FROM can be, and this rebuilds it:
 *
 *   1. the 117 labelled prompts, from upstream's own evals/cases/*.json fixtures
 *   2. the 24 {name, description} pairs the model actually sees, read from the BUILT node
 *
 * Point 2 matters more than it looks. The descriptions are the entire selection surface, so an
 * eval transcribing them by hand would be measuring a copy rather than the shipped artifact.
 *
 * Usage:
 *   node build-selection-dataset.js --skills-repo <path-to-agent-skills-clone> [--out <file>]
 *
 * The clone must be at the SHA pinned in skills-library/VENDOR.md; the script checks the fixture
 * count and warns if the totals no longer match what the document reports.
 */
const fs = require('node:fs')
const path = require('node:path')

const COMPONENTS = path.resolve(__dirname, '..', '..', '..', '..')

/** Totals recorded in docs/SKILL-SELECTION-EVAL.md, so drift is visible rather than silent. */
const EXPECTED = { skills: 24, prompts: 117, positive: 78, negative: 39 }

const arg = (flag) => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? process.argv[i + 1] : undefined
}

const skillsRepo = arg('--skills-repo')
const outFile = arg('--out') || path.join(__dirname, 'selection-dataset.json')

if (!skillsRepo) {
    console.error('usage: node build-selection-dataset.js --skills-repo <path-to-agent-skills-clone> [--out <file>]')
    console.error('\nClone it with:')
    console.error('  git clone https://github.com/addyosmani/agent-skills')
    console.error('  git -C agent-skills checkout <sha from skills-library/VENDOR.md>')
    process.exitCode = 2
    return
}

const casesDir = path.join(skillsRepo, 'evals', 'cases')
if (!fs.existsSync(casesDir)) {
    console.error(`no evals/cases directory under ${skillsRepo} — is that an agent-skills clone?`)
    process.exitCode = 2
    return
}

// ---------------------------------------------------------------- 1. the tool list, from dist/
const distNode = path.join(COMPONENTS, 'dist', 'nodes', 'tools', 'AgentSkills', 'AgentSkills.js')
if (!fs.existsSync(distNode)) {
    console.error(`built node not found at ${distNode}\nrun: pnpm --filter flowise-components build`)
    process.exitCode = 2
    return
}

;(async () => {
    const { nodeClass: AgentSkills } = require(distNode)
    const tools = await new AgentSkills().init({ id: 'skills_0', inputs: {} }, '')
    const toolList = tools.map((t) => ({ name: t.name, description: t.description }))

    // ---------------------------------------------------------------- 2. the labelled prompts
    const prompts = []
    const files = fs
        .readdirSync(casesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()

    for (const file of files) {
        const fixture = JSON.parse(fs.readFileSync(path.join(casesDir, file), 'utf8'))
        const skill = fixture.skill_name
        const trigger = fixture.trigger || {}

        for (const entry of trigger.positive || []) {
            prompts.push({ prompt: entry.prompt, expected: skill, type: 'positive', source: file })
        }
        // A negative case belongs to a DIFFERENT named skill; that owner is the label. Entries with
        // no owner are unlabelled and cannot be scored, so they are excluded rather than guessed at.
        for (const entry of trigger.negative || []) {
            if (!entry.owner) continue
            prompts.push({ prompt: entry.prompt, expected: entry.owner, type: 'negative-owner', source: file })
        }
    }

    // Every label must name a real tool, or the scoring is measuring nothing.
    const known = new Set(toolList.map((t) => t.name))
    const dangling = prompts.filter((p) => !known.has(p.expected))

    const counts = {
        skills: toolList.length,
        prompts: prompts.length,
        positive: prompts.filter((p) => p.type === 'positive').length,
        negative: prompts.filter((p) => p.type === 'negative-owner').length,
        descriptionChars: toolList.reduce((n, t) => n + t.description.length, 0)
    }

    fs.writeFileSync(outFile, JSON.stringify({ generatedFrom: { casesDir, distNode }, counts, tools: toolList, prompts }, null, 2), 'utf8')

    console.info('selection dataset rebuilt')
    console.info(`  skills            : ${counts.skills}`)
    console.info(`  labelled prompts  : ${counts.prompts}  (${counts.positive} positive, ${counts.negative} negative-owner)`)
    console.info(`  description chars : ${counts.descriptionChars}`)
    console.info(`  dangling labels   : ${dangling.length}`)
    console.info(`  written to        : ${path.relative(COMPONENTS, outFile).split(path.sep).join('/')}`)

    let drifted = false
    for (const key of Object.keys(EXPECTED)) {
        if (counts[key] !== EXPECTED[key]) {
            console.info(`  DRIFT: ${key} is ${counts[key]}, docs/SKILL-SELECTION-EVAL.md reports ${EXPECTED[key]}`)
            drifted = true
        }
    }
    if (dangling.length) {
        console.info(`  DANGLING: ${dangling.map((d) => d.expected).join(', ')}`)
        drifted = true
    }
    if (drifted) {
        console.info('\nThe clone is probably not at the SHA pinned in skills-library/VENDOR.md.')
    } else {
        console.info('\nCounts match the published evaluation.')
    }
    process.exitCode = drifted ? 1 : 0
})().catch((e) => {
    console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : String(e)))
    process.exitCode = 1
})
