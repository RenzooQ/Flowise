import * as fs from 'fs'
import * as path from 'path'
import { capDescription, extractSection, extractSections, extractTitle, parseSkillFile, stripBom } from './parser'

const SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills-library', 'skills')

const readSkill = (folder: string): string => fs.readFileSync(path.join(SKILLS_DIR, folder, 'SKILL.md'), 'utf8')

/**
 * Expectations copied as literals from docs/skills-catalog.json rather than read from it:
 * the catalog is not vendored into the fork, and a literal makes a regression obvious in the diff.
 */
const ALL_FOLDERS = [
    'api-and-interface-design',
    'browser-testing-with-devtools',
    'ci-cd-and-automation',
    'code-review-and-quality',
    'code-simplification',
    'context-engineering',
    'debugging-and-error-recovery',
    'deprecation-and-migration',
    'documentation-and-adrs',
    'doubt-driven-development',
    'frontend-ui-engineering',
    'git-workflow-and-versioning',
    'idea-refine',
    'incremental-implementation',
    'interview-me',
    'observability-and-instrumentation',
    'performance-optimization',
    'planning-and-task-breakdown',
    'security-and-hardening',
    'shipping-and-launch',
    'source-driven-development',
    'spec-driven-development',
    'test-driven-development',
    'using-agent-skills'
]

describe('AgentSkills parser', () => {
    describe('the 24 vendored skills', () => {
        it('finds exactly the 24 expected skill folders on disk', () => {
            const found = fs
                .readdirSync(SKILLS_DIR, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort()
            expect(found).toEqual(ALL_FOLDERS)
        })

        it.each(ALL_FOLDERS)('parses %s with name === folder and a non-empty description, title and body', (folder) => {
            const parsed = parseSkillFile(readSkill(folder))
            if (!parsed.ok) throw new Error(`${folder} failed to parse: ${parsed.reason}`)
            expect(parsed.name).toBe(folder)
            expect(parsed.description.length).toBeGreaterThan(0)
            expect(parsed.title.length).toBeGreaterThan(0)
            expect(parsed.body.length).toBeGreaterThan(0)
        })

        it('exposes exactly the two frontmatter keys name and description in 24/24', () => {
            for (const folder of ALL_FOLDERS) {
                const raw = readSkill(folder)
                const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(raw)
                expect(block).not.toBeNull()
                const keys = (block as RegExpExecArray)[1]
                    .split('\n')
                    .filter((line) => /^\S/.test(line))
                    .map((line) => line.slice(0, line.indexOf(':')))
                expect(keys).toEqual(['name', 'description'])
            }
        })

        it('keeps every description inside the 1024-char cap without truncating', () => {
            for (const folder of ALL_FOLDERS) {
                const parsed = parseSkillFile(readSkill(folder))
                if (!parsed.ok) throw new Error(folder)
                expect(capDescription(parsed.description)).toBe(parsed.description)
            }
        })
    })

    describe('frontmatter splitting', () => {
        it('is not fooled by Markdown table separators (source-driven-development contains "---" rows)', () => {
            const raw = readSkill('source-driven-development')
            expect(raw).toContain('---')
            const parsed = parseSkillFile(raw)
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(parsed.name).toBe('source-driven-development')
            expect(parsed.body.startsWith('# Source-Driven Development')).toBe(true)
        })

        it('parses a CRLF file identically to its LF form, apart from the line endings', () => {
            const lf = readSkill('spec-driven-development')
            const crlf = lf.replace(/\n/g, '\r\n')
            const a = parseSkillFile(lf)
            const b = parseSkillFile(crlf)
            if (!a.ok || !b.ok) throw new Error('one of the forms failed to parse')
            expect(b.name).toBe(a.name)
            expect(b.description).toBe(a.description)
            expect(b.title).toBe(a.title)
            expect(b.sections).toEqual(a.sections)
            expect(b.body.replace(/\r\n/g, '\n')).toBe(a.body)
        })

        it('strips a UTF-8 BOM before matching the frontmatter fence', () => {
            const raw = readSkill('spec-driven-development')
            // Written as an escape, not a literal: a bare BOM trips eslint's no-irregular-whitespace.
            const BOM = '\ufeff'
            expect(stripBom(`${BOM}${raw}`)).toBe(raw)
            const withBom = parseSkillFile(`${BOM}${raw}`)
            const without = parseSkillFile(raw)
            if (!withBom.ok || !without.ok) throw new Error('BOM form failed to parse')
            expect(withBom.body).toBe(without.body)
        })
    })

    describe('malformed input is skipped, never thrown', () => {
        const cases: Array<[string, string]> = [
            ['no fence at all', '# Just a heading\n\nSome text.\n'],
            ['unterminated fence', '---\nname: x\ndescription: y\n\n# Body\n'],
            ['invalid YAML', '---\nname: [unclosed\n---\n\n# Body\n'],
            ['missing description', '---\nname: only-a-name\n---\n\n# Body\n'],
            ['missing name', '---\ndescription: only a description\n---\n\n# Body\n'],
            ['name is not a string', '---\nname: 42\ndescription: a description\n---\n\n# Body\n'],
            ['description is not a string', '---\nname: a-name\ndescription:\n  - a\n  - b\n---\n\n# Body\n'],
            ['empty name', '---\nname: ""\ndescription: a description\n---\n\n# Body\n'],
            ['YAML scalar instead of a mapping', '---\njust a scalar\n---\n\n# Body\n'],
            ['YAML sequence instead of a mapping', '---\n- a\n- b\n---\n\n# Body\n'],
            ['empty frontmatter block', '---\n\n---\n\n# Body\n']
        ]

        it.each(cases)('skips with a reason and does not throw: %s', (_label, raw) => {
            let parsed
            expect(() => {
                parsed = parseSkillFile(raw)
            }).not.toThrow()
            expect(parsed).toBeDefined()
            expect((parsed as any).ok).toBe(false)
            expect(typeof (parsed as any).reason).toBe('string')
            expect((parsed as any).reason.length).toBeGreaterThan(0)
        })

        it('does not construct a JS function from a !!js/function tag (js-yaml v4 default schema)', () => {
            const raw = '---\nname: hostile\ndescription: hostile\nevil: !!js/function "function () { return 1 }"\n---\n\n# Body\n'
            const parsed = parseSkillFile(raw)
            // v4's default schema has no JS types, so the tag is an unknown-tag error - a skip, not an eval.
            expect(parsed.ok).toBe(false)
        })
    })

    describe('non-ASCII round trip', () => {
        it('preserves box drawing, arrows and comparison glyphs byte for byte', () => {
            const raw = '---\nname: glyphs\ndescription: glyphs\n---\n\n# Glyphs\n\n┌─┐│└┘├┤ → ← ▼ ▲ ✓ ✗ ≤ ≥ ≠ ± — em-dash\n'
            const parsed = parseSkillFile(raw)
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(parsed.body).toBe('# Glyphs\n\n┌─┐│└┘├┤ → ← ▼ ▲ ✓ ✗ ≤ ≥ ≠ ± — em-dash\n')
        })

        it('preserves the non-ASCII content of every vendored skill body', () => {
            for (const folder of ALL_FOLDERS) {
                const raw = readSkill(folder)
                const parsed = parseSkillFile(raw)
                if (!parsed.ok) throw new Error(folder)
                expect(raw.endsWith(parsed.body)).toBe(true)
            }
        })
    })

    describe('section index', () => {
        it('ignores the 11 "##" headings that live inside fenced code blocks in documentation-and-adrs', () => {
            const raw = readSkill('documentation-and-adrs')
            const parsed = parseSkillFile(raw)
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(parsed.sections).toEqual([
                'Overview',
                'When to Use',
                'Architecture Decision Records (ADRs)',
                'Inline Documentation',
                'API Documentation',
                'README Structure',
                'Changelog Maintenance',
                'Documentation for Agents',
                'Common Rationalizations',
                'Red Flags',
                'Verification'
            ])
            // The raw file really does contain more '##' lines than the section list, which is
            // what makes the fence stripping load-bearing rather than decorative.
            const rawHashHash = parsed.body.split('\n').filter((l) => /^##[ \t]+/.test(l)).length
            expect(rawHashHash).toBeGreaterThan(parsed.sections.length)
        })

        it('lists idea-refine sections without the in-fence template headings', () => {
            const parsed = parseSkillFile(readSkill('idea-refine'))
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(parsed.sections).toEqual(['How It Works', 'Usage', 'Output', 'Detailed Instructions', 'Red Flags', 'Verification'])
        })

        it('extractSections and extractTitle work on a bare body too', () => {
            const body = '# Title\n\n## One\n\ntext\n\n```md\n## Not A Section\n```\n\n## Two\n'
            expect(extractTitle(body)).toBe('Title')
            expect(extractSections(body)).toEqual(['One', 'Two'])
        })
    })

    describe('heading extraction - the three named hazards', () => {
        it('exact before prefix: "When to Use" returns the short section, not "When to Use Subagents for Testing"', () => {
            const parsed = parseSkillFile(readSkill('test-driven-development'))
            if (!parsed.ok) throw new Error(parsed.reason)
            const section = extractSection(parsed.body, 'When to Use')
            expect(section.startsWith('## When to Use\n')).toBe(true)
            expect(section).not.toContain('## When to Use Subagents for Testing')
            expect(section.length).toBeLessThan(parsed.body.length)
        })

        it('H3: idea-refine resolves "Process" to its "### Process" heading', () => {
            const parsed = parseSkillFile(readSkill('idea-refine'))
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(parsed.sections).not.toContain('Process')
            const section = extractSection(parsed.body, 'Process')
            expect(section.startsWith('### Process')).toBe(true)
            expect(section.length).toBeLessThan(parsed.body.length)
        })

        it('prefix: security-and-hardening resolves "Process" to "## Process: Threat Model First"', () => {
            const parsed = parseSkillFile(readSkill('security-and-hardening'))
            if (!parsed.ok) throw new Error(parsed.reason)
            const section = extractSection(parsed.body, 'Process')
            expect(section.startsWith('## Process: Threat Model First')).toBe(true)
            expect(section).not.toContain('## The Three-Tier Boundary System')
        })

        it('an H2 section is not terminated by its own H3 subheadings', () => {
            const body = '# T\n\n## Alpha\n\nintro\n\n### Sub\n\nnested\n\n## Beta\n\nother\n'
            const section = extractSection(body, 'Alpha')
            expect(section).toContain('### Sub')
            expect(section).toContain('nested')
            expect(section).not.toContain('## Beta')
        })

        it('an absent heading falls back to the complete body', () => {
            const parsed = parseSkillFile(readSkill('spec-driven-development'))
            if (!parsed.ok) throw new Error(parsed.reason)
            expect(extractSection(parsed.body, 'No Such Heading Anywhere')).toBe(parsed.body)
            expect(extractSection(parsed.body, '')).toBe(parsed.body)
            expect(extractSection(parsed.body, '   ')).toBe(parsed.body)
        })

        it('matches case-insensitively and tolerates a trailing colon and extra whitespace', () => {
            const parsed = parseSkillFile(readSkill('spec-driven-development'))
            if (!parsed.ok) throw new Error(parsed.reason)
            const canonical = extractSection(parsed.body, 'Verification')
            expect(canonical.startsWith('## Verification')).toBe(true)
            expect(extractSection(parsed.body, '  verification  ')).toBe(canonical)
            expect(extractSection(parsed.body, 'VERIFICATION:')).toBe(canonical)
        })

        it('never returns a heading that only appears inside a fenced code block', () => {
            const body = '# T\n\n## Real\n\ntext\n\n```md\n## Fenced Only\ncontent\n```\n'
            expect(extractSection(body, 'Fenced Only')).toBe(body)
        })
    })

    describe('capDescription', () => {
        it('leaves a short description untouched', () => {
            expect(capDescription('short')).toBe('short')
        })

        it('truncates a 2000-char description to at most 1024 chars, at a word boundary, with an ellipsis', () => {
            const long = 'word '.repeat(400).trim()
            expect(long.length).toBeGreaterThan(1024)
            const capped = capDescription(long)
            expect(capped.length).toBeLessThanOrEqual(1024)
            expect(capped.endsWith('…')).toBe(true)
            expect(capped.endsWith(' …')).toBe(false)
            expect(long.startsWith(capped.slice(0, -1))).toBe(true)
        })

        it('still caps a single unbroken token that has no word boundary', () => {
            const capped = capDescription('x'.repeat(2000))
            expect(capped.length).toBeLessThanOrEqual(1024)
            expect(capped.endsWith('…')).toBe(true)
        })
    })
})
