import { load } from 'js-yaml'
import { ParsedSkill } from './types'

/**
 * SKILL.md parsing. Pure functions over strings - this file never touches `fs`.
 *
 * Skill text is untrusted reference data, never code. Nothing here evaluates,
 * compiles or executes any part of a skill file.
 */

/**
 * Anchored frontmatter matcher. A naive `split('---')` breaks on every one of the 24
 * vendored skills, because Markdown table separators (`|---|---|`) contain `---`
 * (`performance-optimization` alone yields 47 parts). No vendored file uses a `---`
 * horizontal rule in its body, so anchoring to the start of the document is safe.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/

/**
 * Fenced code blocks, matched by their own opening fence length so a longer fence can
 * contain a shorter one. 10 of the 24 skills carry `##` headings inside fences
 * (`documentation-and-adrs` has 11); those are templates the skill tells the agent to
 * *write*, not sections of the skill itself.
 */
const FENCED_BLOCK_RE = /^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t\r]*$/gm

/** Upstream's own description budget. Longer descriptions are capped, never silently cut mid-word. */
export const MAX_DESCRIPTION_CHARS = 1024

/** Strip a UTF-8 BOM. Present in no vendored file, but cheap insurance for user-supplied ones. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/**
 * Blank out every fenced code block, so `##` headings inside fences disappear.
 *
 * Length-preserving on purpose: each non-newline character becomes a space rather than being
 * deleted, so an offset into the stripped text indexes the original text 1:1. `extractSection`
 * depends on that to locate a heading in the stripped copy and then slice the original.
 */
export const stripFencedCodeBlocks = (body: string): string => body.replace(FENCED_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '))

/** '##' heading texts in document order, fenced code stripped first. */
export const extractSections = (body: string): string[] => {
    const sections: string[] = []
    const stripped = stripFencedCodeBlocks(body)
    for (const line of stripped.split(/\r?\n/)) {
        const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
        if (match) sections.push(match[1])
    }
    return sections
}

/** The body H1 without its leading '# '. The vendored skills put it on the first non-blank body line. */
export const extractTitle = (body: string): string => {
    const stripped = stripFencedCodeBlocks(body)
    const match = /^#[ \t]+(.+?)[ \t]*$/m.exec(stripped)
    return match ? match[1] : ''
}

/** Lowercase, trim, collapse internal whitespace, drop one trailing colon. */
const normaliseHeading = (heading: string): string => heading.trim().toLowerCase().replace(/\s+/g, ' ').replace(/:$/, '')

/**
 * Collect every heading of one level with the offsets of its own line and of the next
 * heading at that level *or shallower*, so an H3 subheading never terminates an H2 section.
 */
const collectHeadings = (stripped: string, level: 2 | 3): Array<{ text: string; start: number; end: number }> => {
    const marker = '#'.repeat(level)
    // A heading at `level` or shallower terminates a section at `level`.
    const boundary = new RegExp(`^#{1,${level}}[ \\t]+`)
    const headingAtLevel = new RegExp(`^${marker}[ \\t]+(.+?)[ \\t]*$`)

    const lines = stripped.split('\n')
    const offsets: number[] = []
    let offset = 0
    for (const line of lines) {
        offsets.push(offset)
        offset += line.length + 1
    }

    const found: Array<{ text: string; start: number; end: number }> = []
    for (let i = 0; i < lines.length; i++) {
        const match = headingAtLevel.exec(lines[i])
        if (!match) continue
        let end = stripped.length
        for (let j = i + 1; j < lines.length; j++) {
            if (boundary.test(lines[j])) {
                end = offsets[j]
                break
            }
        }
        found.push({ text: match[1], start: offsets[i], end })
    }
    return found
}

/**
 * Return the slice of `body` under `heading`, or the whole body when it is absent.
 *
 * Resolution order is exact H2 -> exact H3 -> prefix H2 -> prefix H3 -> full body, taking the
 * FIRST occurrence at each stage. That order exists to handle three real cases in the library:
 *
 *  - `test-driven-development` has both `## When to Use` and `## When to Use Subagents for
 *    Testing`, so an exact match must be tried before any prefix match.
 *  - `idea-refine` has `### Process` at H3, so H3 must be tried at all.
 *  - `security-and-hardening` has `## Process: Threat Model First`, so a normalised prefix
 *    match is needed to find it from `Process`.
 *
 * A miss is normal, not an error: it falls back to the whole post-frontmatter body silently.
 * The returned slice is cut from the ORIGINAL body, so fenced code inside a section survives -
 * fences are stripped only to locate headings.
 */
export const extractSection = (body: string, heading: string): string => {
    const wanted = normaliseHeading(heading)
    if (!wanted) return body

    // Offsets come from the stripped text, which preserves every newline, so they index the
    // original body 1:1 as long as CRLF is normalised the same way in both.
    const source = body.replace(/\r\n/g, '\n')
    const stripped = stripFencedCodeBlocks(source)

    const h2 = collectHeadings(stripped, 2)
    const h3 = collectHeadings(stripped, 3)

    const exact = (candidates: typeof h2) => candidates.find((c) => normaliseHeading(c.text) === wanted)
    const prefix = (candidates: typeof h2) => candidates.find((c) => normaliseHeading(c.text).startsWith(wanted))

    const hit = exact(h2) ?? exact(h3) ?? prefix(h2) ?? prefix(h3)
    if (!hit) return body

    return source.slice(hit.start, hit.end).trimEnd()
}

/** Truncate at the last word boundary before the cap and mark it. Returns the input unchanged when it fits. */
export const capDescription = (description: string, max: number = MAX_DESCRIPTION_CHARS): string => {
    if (description.length <= max) return description
    const head = description.slice(0, max - 1)
    const lastSpace = head.lastIndexOf(' ')
    return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`
}

/**
 * Parse one SKILL.md. Never throws: every failure path returns `{ ok: false, reason }` so a
 * single malformed file can never take down the registry, the node or NodesPool.
 */
export const parseSkillFile = (raw: string): ParsedSkill => {
    const text = stripBom(raw)

    const match = FRONTMATTER_RE.exec(text)
    if (!match) {
        return { ok: false, reason: 'no YAML frontmatter block found at the start of the file' }
    }

    let frontmatter: unknown
    try {
        // js-yaml v4's default schema has no JS types, so `!!js/function` cannot be constructed.
        // Never `loadAll`, never DEFAULT_FULL_SCHEMA - see the exact 4.1.0 pin in package.json.
        frontmatter = load(match[1])
    } catch (error) {
        return { ok: false, reason: `frontmatter is not valid YAML (${error instanceof Error ? error.message : 'parse error'})` }
    }

    // Validate defensively regardless of the version pin.
    if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        return { ok: false, reason: 'frontmatter is not a YAML mapping' }
    }

    const { name, description } = frontmatter as Record<string, unknown>
    if (typeof name !== 'string' || name.trim() === '') {
        return { ok: false, reason: 'frontmatter "name" is missing or is not a non-empty string' }
    }
    if (typeof description !== 'string' || description.trim() === '') {
        return { ok: false, reason: 'frontmatter "description" is missing or is not a non-empty string' }
    }

    // Unknown keys are ignored on purpose. Upstream's own linter probes for `type` and `exempt`
    // and refuses them, so a parser must not start trusting them.
    const body = text.slice(match[0].length).trimStart()

    return {
        ok: true,
        name: name.trim(),
        description: description.trim(),
        title: extractTitle(body),
        body,
        sections: extractSections(body)
    }
}
