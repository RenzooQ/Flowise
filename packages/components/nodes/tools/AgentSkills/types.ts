/**
 * Shape-only declarations for the Agent Skills subsystem.
 *
 * This file deliberately has no imports at all, so it can never take part in an
 * import cycle with `src/` (which already imports from `nodes/`).
 */

/** One indexed skill. Bodies are NOT held here - see `loadSkillBody`. */
export interface SkillMeta {
    /** Directory name under the skills root. The primary key. */
    folder: string
    /** Frontmatter `name`. Equals `folder` in all 24 vendored skills, but that is not assumed. */
    name: string
    /** Frontmatter `description`, verbatim. This is the tool description the model selects on. */
    description: string
    /** The body H1 without its leading '# '. Prose, not the slug. Empty if the body has no H1. */
    title: string
    /** Sanitised and de-duplicated tool name. */
    toolName: string
    /** Absolute path to the skill's SKILL.md. */
    absolutePath: string
    /** '##' heading texts in document order, with fenced code blocks stripped first. */
    sections: string[]
    /**
     * Basenames of the `../../references/*.md` companion files THIS skill links to, de-duplicated
     * and sorted. Derived from the vendored body, never from user or model input, and it is what
     * bounds `loadSkillReference`: a skill can only reach a companion it actually cites.
     */
    references: string[]
    /** Size of SKILL.md on disk, in bytes. */
    sizeBytes: number
}

/** The result of indexing one skills directory. */
export interface SkillIndex {
    /** The resolved absolute directory that was scanned. Empty when nothing resolved. */
    skillsDir: string
    /** Sorted by `folder`, so de-duplication suffixes are deterministic across runs. */
    skills: SkillMeta[]
    /** One human-readable line per skipped or repaired file. Never thrown, always collected. */
    warnings: string[]
    /** `Date.now()` at the time the index was built. Drives the TTL cache. */
    loadedAt: number
}

/** Outcome of parsing one SKILL.md. A discriminated union so callers cannot ignore the failure case. */
export type ParsedSkill = ParsedSkillOk | ParsedSkillSkip

export interface ParsedSkillOk {
    ok: true
    name: string
    description: string
    title: string
    body: string
    sections: string[]
    /** See `SkillMeta.references`. */
    references: string[]
}

export interface ParsedSkillSkip {
    ok: false
    /** Why the file was skipped, phrased for a `console.warn` line. */
    reason: string
}
