import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSkillFile } from './parser'

/**
 * Invariants of the vendored skills library.
 *
 * `skills-library/VENDOR.md` states these as prose and asks whoever re-vendors to "assert the
 * counts" by hand. Nothing checked them, so the guarantees the NOTICE makes to a reader — that this
 * is third-party MIT content, unmodified, and containing no executable — rested on someone
 * remembering a manual step. These are the same assertions, run by CI.
 *
 * The counts are deliberately exact rather than lower bounds. A re-vendor that changes them is
 * supposed to be a decision someone records in VENDOR.md, not something that lands quietly.
 */
const LIBRARY = path.join(__dirname, '..', '..', '..', 'skills-library')
const SKILLS = path.join(LIBRARY, 'skills')
const REFERENCES = path.join(LIBRARY, 'references')

/** Every file under the vendored tree, recursively. */
const walk = (dir: string): string[] => {
    const found: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) found.push(...walk(full))
        else found.push(full)
    }
    return found
}

describe('vendored skills library', () => {
    const allFiles = walk(LIBRARY)

    describe('shape, as recorded in VENDOR.md', () => {
        it('holds exactly 24 SKILL.md files', () => {
            const skillFiles = allFiles.filter((f) => path.basename(f) === 'SKILL.md')
            expect(skillFiles).toHaveLength(24)
        })

        it('holds exactly 35 Markdown files in total', () => {
            // 24 SKILL.md + idea-refine's 3 companions + 7 references + VENDOR.md
            expect(allFiles.filter((f) => f.endsWith('.md'))).toHaveLength(35)
        })

        it('carries the upstream LICENSE, and it is the MIT text attributed to Addy Osmani', () => {
            const license = fs.readFileSync(path.join(LIBRARY, 'LICENSE'), 'utf8')
            expect(license).toContain('MIT License')
            expect(license).toContain('Addy Osmani')
        })

        it('contains nothing but Markdown and that LICENSE', () => {
            const others = allFiles.filter((f) => !f.endsWith('.md') && path.basename(f) !== 'LICENSE')
            expect(others).toEqual([])
        })

        it('keeps the 11 skills that link to ../../references resolvable', () => {
            // The layout arithmetic is load-bearing: skills/<x>/SKILL.md -> ../../references/.
            expect(fs.existsSync(REFERENCES)).toBe(true)
            const referenced = new Set<string>()
            for (const file of allFiles.filter((f) => path.basename(f) === 'SKILL.md')) {
                const body = fs.readFileSync(file, 'utf8')
                for (const match of body.matchAll(/\.\.\/\.\.\/references\/([\w.-]+\.md)/g)) referenced.add(match[1])
            }
            for (const target of referenced) {
                expect(fs.existsSync(path.join(REFERENCES, target))).toBe(true)
            }
        })
    })

    describe('the pinned upstream SHA is stated consistently', () => {
        // VENDOR.md's re-vendor procedure says "update the commit SHA and fetch date in the table
        // above" — one file. The SHA is actually written in seven, 37 times, including the NOTICE
        // and the README. Following that procedure to the letter leaves 36 stale references
        // claiming provenance the tree no longer has, which is exactly the kind of quiet
        // inaccuracy a licence notice must not carry. This makes the copies self-checking, so the
        // procedure only has to be right about VENDOR.md.
        const REPO = path.join(__dirname, '..', '..', '..', '..', '..')

        /** Files that state the provenance SHA. Extend this if another one starts quoting it. */
        const CLAIMANTS = [
            'NOTICE',
            'README.md',
            path.join('docs', 'INTEGRATION_PLAN.md'),
            path.join('docs', 'SKILL-SELECTION-EVAL.md'),
            path.join('docs', 'skills-catalog.json'),
            path.join('docs', 'skills-format.md')
        ]

        const vendorText = fs.readFileSync(path.join(LIBRARY, 'VENDOR.md'), 'utf8')
        const pinned = (/\b([0-9a-f]{40})\b/.exec(vendorText) || [])[1]

        it('VENDOR.md pins a full 40-character SHA', () => {
            expect(pinned).toMatch(/^[0-9a-f]{40}$/)
        })

        it.each(CLAIMANTS)('%s quotes only that SHA', (relative) => {
            const full = path.join(REPO, relative)
            if (!fs.existsSync(full)) return // the doc set may be trimmed; absence is not a mismatch
            const text = fs.readFileSync(full, 'utf8')

            // Full 40-char forms must match exactly.
            for (const [, sha] of text.matchAll(/\b([0-9a-f]{40})\b/g)) {
                expect(sha).toBe(pinned)
            }
            // Abbreviated forms must be a prefix of it. Bounded to 7-12 chars and required to
            // contain a digit, so ordinary words like "deadbeef" or "added" are not swept in.
            for (const [, short] of text.matchAll(/\b([0-9a-f]{7,12})\b/g)) {
                if (!/\d/.test(short)) continue
                if (!pinned.startsWith(short) && short !== pinned.slice(0, short.length)) {
                    // Only fail on strings that look like they are TRYING to be this SHA.
                    if (pinned.startsWith(short.slice(0, 4))) {
                        throw new Error(`${relative} quotes "${short}", which is not a prefix of the pinned ${pinned}`)
                    }
                }
            }
        })
    })

    describe('a skill is text, never code', () => {
        // The whole trust story depends on this tree holding nothing that could be executed. A
        // future re-vendor that sweeps in a script should fail here rather than ship.
        it('contains no executable file of any kind', () => {
            const executable = allFiles.filter((f) => /\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|ps1|bat|cmd|exe|dll)$/i.test(f))
            expect(executable).toEqual([])
        })

        it('contains no symbolic links', () => {
            // Upstream's .opencode/skills is a symlink; the registry refuses links, but the tree
            // should not carry one in the first place.
            const links = allFiles.filter((f) => fs.lstatSync(f).isSymbolicLink())
            expect(links).toEqual([])
        })
    })

    describe('every vendored skill is loadable', () => {
        const skillDirs = fs
            .readdirSync(SKILLS, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)

        it('exposes 24 skill directories', () => {
            expect(skillDirs).toHaveLength(24)
        })

        it.each(skillDirs)('%s parses, with a non-empty name, description and body', (folder) => {
            const parsed = parseSkillFile(fs.readFileSync(path.join(SKILLS, folder, 'SKILL.md'), 'utf8'))
            expect(parsed.ok).toBe(true)
            if (!parsed.ok) return
            expect(parsed.name.trim()).not.toBe('')
            expect(parsed.description.trim()).not.toBe('')
            expect(parsed.body.trim()).not.toBe('')
        })

        it('has a unique frontmatter name per skill, so no two tools collide', () => {
            const names = skillDirs.map((folder) => {
                const parsed = parseSkillFile(fs.readFileSync(path.join(SKILLS, folder, 'SKILL.md'), 'utf8'))
                return parsed.ok ? parsed.name : folder
            })
            expect(new Set(names).size).toBe(names.length)
        })

        it('keeps every description within the 1024-character budget, so none is truncated', () => {
            // Truncation is handled gracefully, but a bundled skill hitting it would silently lose
            // part of the "Use when ..." clause the whole selection design rests on.
            for (const folder of skillDirs) {
                const parsed = parseSkillFile(fs.readFileSync(path.join(SKILLS, folder, 'SKILL.md'), 'utf8'))
                if (parsed.ok) expect(parsed.description.length).toBeLessThanOrEqual(1024)
            }
        })
    })
})
