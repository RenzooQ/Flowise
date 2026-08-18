import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSkillFile } from './parser'
import { SkillIndex, SkillMeta } from './types'

/**
 * Discovery, indexing and caching of skill directories. This file owns all `fs` access
 * for the Agent Skills subsystem.
 *
 * Security posture, all of it enforced here rather than promised elsewhere:
 *   - only files literally named `SKILL.md` are ever opened,
 *   - only one directory level below the skills root,
 *   - symlinked entries are refused,
 *   - at most MAX_SKILL_DIR_ENTRIES entries are scanned and files above MAX_SKILL_FILE_BYTES
 *     are skipped,
 *   - nothing read from disk is ever evaluated, compiled or executed.
 *
 * The filename pin is the load-bearing one: it is what stops this from becoming a
 * model-steerable file reader over a directory the flow author can repoint.
 *
 * One cross-platform caveat worth knowing rather than discovering: the pin is resolved by the
 * filesystem, so it is case-SENSITIVE on Linux and case-INSENSITIVE on Windows and macOS. A
 * directory containing `skill.md` indexes on Windows and does not on Linux. Only ever one filename
 * is opened either way, so the bound holds; do not assume exact-case behaviour is portable.
 */

/** Directory name of the vendored library, relative to the components package root. */
const VENDORED_SKILLS_SUBPATH = path.join('skills-library', 'skills')

/** Index entries live this long before the directory is re-scanned. Bodies are never cached. */
export const SKILL_INDEX_TTL_MS = 60_000

/** Upper bound on entries scanned in one skills directory. The vendored library has 24. */
export const MAX_SKILL_DIR_ENTRIES = 500

/** A SKILL.md above this size is skipped. The largest vendored file is about 24 KB. */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024

/** Tool names are capped at this length before de-duplication suffixes are applied. */
const MAX_TOOL_NAME_CHARS = 64

/**
 * Most entries this map will ever hold: the bundled library plus a handful of override directories.
 * The key is a caller-supplied path (the Skills Directory input reaches here via
 * POST /api/v1/node-load-method), and the TTL only forces a REBUILD of an entry, never a removal, so
 * without a bound any flow editor could grow this map one entry per distinct path they name and it
 * would retain up to MAX_SKILL_DIR_ENTRIES SkillMeta objects each for the lifetime of the process.
 */
const MAX_CACHED_INDEXES = 16

const indexCache = new Map<string, SkillIndex>()

/** Evict the least recently loaded entries until the cache is within MAX_CACHED_INDEXES. */
const evictOldestIndexes = (): void => {
    if (indexCache.size <= MAX_CACHED_INDEXES) return
    const byAge = [...indexCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)
    for (const [key] of byAge.slice(0, indexCache.size - MAX_CACHED_INDEXES)) indexCache.delete(key)
}

const warn = (message: string): void => console.warn(`[AgentSkills] ${message}`)

const isDirectory = async (candidate: string): Promise<boolean> => {
    try {
        return (await fs.promises.stat(candidate)).isDirectory()
    } catch {
        return false
    }
}

/**
 * Resolve the directory holding the skills.
 *
 * The components gulpfile copies only images out of `nodes/`, so the vendored Markdown never
 * reaches the built tree and the library has to be found relative to `__dirname` at call time.
 * The depth differs between a dev or jest run (`packages/components/nodes/tools/AgentSkills`,
 * 3 levels up to the package root) and a built run (`packages/components/dist/nodes/tools/
 * AgentSkills`, 4 levels up), so this probes a list and takes the first hit rather than assuming
 * one depth - the same shape as `src/modelLoader.ts:12-20` and `src/utils.ts:223-227`, which
 * probes 1 through 5.
 *
 * An override that is given but does not resolve returns '' rather than falling back to the bundled
 * library. Falling back would silently swap a DIFFERENT set of instructions into an agent whose
 * author asked for their own - the warning only reaches the server log, which a flow author never
 * sees. Returning '' makes `init()` throw with the bad path in the message, which is the visible
 * failure the design asks for. The bundled library is the default only when no override was given.
 *
 * Returns '' when nothing resolves. Callers decide what that means; this never throws.
 */
export const resolveSkillsDir = async (override?: string): Promise<string> => {
    const trimmed = (override ?? '').trim()
    if (trimmed) {
        if (await isDirectory(trimmed)) return path.resolve(trimmed)
        warn(`skills directory override "${trimmed}" is not a readable directory`)
        return ''
    }

    const candidates = [
        path.join(__dirname, '..', '..', '..', VENDORED_SKILLS_SUBPATH),
        path.join(__dirname, '..', '..', '..', '..', VENDORED_SKILLS_SUBPATH),
        path.join(__dirname, '..', '..', '..', '..', '..', VENDORED_SKILLS_SUBPATH)
    ]
    for (const candidate of candidates) {
        if (await isDirectory(candidate)) return path.resolve(candidate)
    }
    return ''
}

/**
 * `lower -> spaces to underscore -> drop anything outside [a-z0-9_-] -> fall back -> cap at 64`.
 *
 * Two deliberate differences from the private `sanitizeToolName` in `nodes/agentflow/Agent/Agent.ts`,
 * stated so a reviewer does not read them as bugs: the empty-name fallback is `skill_${index}`
 * rather than a random name, because a random tool name is not reproducible across a restart and
 * makes tests and logs unreadable; and de-duplication is added, which the upstream helper has none of.
 *
 * Flowise does NOT sanitise tool names returned from a Tool node's `init()`, so this node does it
 * itself. All 24 vendored names survive unchanged with zero collisions, so on the bundled library
 * this is a no-op; it matters for user-supplied skill directories, which is precisely where it should.
 */
export const sanitizeToolName = (name: string, index: number): string => {
    const cleaned = name
        .toLowerCase()
        .replace(/ /g, '_')
        .replace(/[^a-z0-9_-]/g, '')
    return (cleaned || `skill_${index}`).slice(0, MAX_TOOL_NAME_CHARS)
}

/** Append `_2`, `_3`, ... on a collision, trimming the base so the total stays within the cap. */
const deduplicateToolName = (candidate: string, taken: Set<string>): string => {
    if (!taken.has(candidate)) return candidate
    for (let suffix = 2; ; suffix++) {
        const tail = `_${suffix}`
        const next = `${candidate.slice(0, MAX_TOOL_NAME_CHARS - tail.length)}${tail}`
        if (!taken.has(next)) return next
    }
}

/** Read one candidate directory entry into a SkillMeta, or return null and push a warning. */
const indexOneSkill = async (skillsDir: string, folder: string, warnings: string[]): Promise<Omit<SkillMeta, 'toolName'> | null> => {
    const absolutePath = path.join(skillsDir, folder, 'SKILL.md')

    let stats: fs.Stats
    try {
        // lstat, not stat: stat FOLLOWS symlinks, so a symlinked SKILL.md pointing anywhere on disk
        // would be read and its contents handed to the model. Directory entries are already refused
        // when they are links (below); refusing the file too keeps that guarantee consistent.
        stats = await fs.promises.lstat(absolutePath)
    } catch {
        warnings.push(`"${folder}" has no SKILL.md; skipped`)
        return null
    }

    if (stats.isSymbolicLink()) {
        warnings.push(`"${folder}/SKILL.md" is a symbolic link; skipped`)
        return null
    }
    if (!stats.isFile()) {
        warnings.push(`"${folder}/SKILL.md" is not a regular file; skipped`)
        return null
    }
    if (stats.size > MAX_SKILL_FILE_BYTES) {
        warnings.push(`"${folder}/SKILL.md" is ${stats.size} bytes, above the ${MAX_SKILL_FILE_BYTES}-byte limit; skipped`)
        return null
    }

    let raw: string
    try {
        raw = await fs.promises.readFile(absolutePath, 'utf8')
    } catch (error) {
        warnings.push(`"${folder}/SKILL.md" could not be read (${error instanceof Error ? error.message : 'read error'}); skipped`)
        return null
    }

    const parsed = parseSkillFile(raw)
    if (!parsed.ok) {
        warnings.push(`"${folder}/SKILL.md" ${parsed.reason}; skipped`)
        return null
    }

    // Valid frontmatter with nothing after it is not a parse failure, so the parser correctly
    // reports ok. It is still a degenerate skill: the tool would be selectable by the model and
    // then return an empty payload. Index it rather than dropping a skill the user may have
    // selected on purpose, but say so - a silently thin tool is the hardest kind to debug from a flow.
    if (parsed.body.trim() === '') {
        warnings.push(`"${folder}/SKILL.md" has no body after its frontmatter; the tool will return an empty payload`)
    }

    return {
        folder,
        name: parsed.name,
        description: parsed.description,
        title: parsed.title,
        absolutePath,
        sections: parsed.sections,
        sizeBytes: stats.size
    }
}

/**
 * Scan `<dir>/<skill-name>/SKILL.md`, one level deep, and build an index.
 *
 * Never throws. A missing directory, an unreadable entry or a malformed file each become a
 * warning line, because a throw here would take out `NodesPool` and make the node vanish
 * from the palette with a single log line.
 */
export const buildSkillIndex = async (skillsDir: string): Promise<SkillIndex> => {
    const warnings: string[] = []

    if (!skillsDir) {
        warnings.push('no skills directory could be resolved')
        return { skillsDir: '', skills: [], warnings, loadedAt: Date.now() }
    }

    let entries: fs.Dirent[]
    try {
        entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch (error) {
        warnings.push(`skills directory "${skillsDir}" could not be read (${error instanceof Error ? error.message : 'read error'})`)
        return { skillsDir, skills: [], warnings, loadedAt: Date.now() }
    }

    if (entries.length > MAX_SKILL_DIR_ENTRIES) {
        warnings.push(
            `skills directory "${skillsDir}" holds ${entries.length} entries; only the first ${MAX_SKILL_DIR_ENTRIES} are scanned`
        )
    }

    const folders: string[] = []
    for (const entry of entries.slice(0, MAX_SKILL_DIR_ENTRIES)) {
        if (entry.name.startsWith('.')) continue
        // Refused before any stat or read, so a symlinked entry cannot be used to leave the root.
        if (entry.isSymbolicLink()) {
            warnings.push(`"${entry.name}" is a symbolic link; skipped`)
            continue
        }
        if (!entry.isDirectory()) continue
        folders.push(entry.name)
    }
    // Sorted so de-duplication suffixes are assigned deterministically across runs.
    folders.sort()

    const skills: SkillMeta[] = []
    const taken = new Set<string>()
    for (const folder of folders) {
        let base: Omit<SkillMeta, 'toolName'> | null = null
        try {
            base = await indexOneSkill(skillsDir, folder, warnings)
        } catch (error) {
            // Belt and braces: indexOneSkill already catches per step, but one malformed file must
            // never take down the registry, the node or NodesPool under any circumstance.
            warnings.push(`"${folder}" failed to index (${error instanceof Error ? error.message : 'unknown error'}); skipped`)
        }
        if (!base) continue

        const toolName = deduplicateToolName(sanitizeToolName(base.name, skills.length), taken)
        taken.add(toolName)
        skills.push({ ...base, toolName })
    }

    return { skillsDir, skills, warnings, loadedAt: Date.now() }
}

/**
 * Cached index for a resolved skills directory, rebuilt once the TTL expires.
 *
 * Bodies are deliberately absent from the index: 24 bodies are roughly 75k tokens / 299 KB and a
 * body is needed at most once, at tool-call time. A side benefit is that editing a skill's text
 * takes effect on the very next tool call; only adding, removing or renaming a skill waits for the TTL.
 */
export const getSkillIndex = async (override?: string): Promise<SkillIndex> => {
    const skillsDir = await resolveSkillsDir(override)
    const cached = indexCache.get(skillsDir)
    if (cached && Date.now() - cached.loadedAt < SKILL_INDEX_TTL_MS) return cached

    const index = await buildSkillIndex(skillsDir)
    for (const message of index.warnings) warn(message)
    indexCache.set(skillsDir, index)
    evictOldestIndexes()
    return index
}

/** Drop every cached index. Exported for tests and for a forced re-scan. */
export const clearSkillIndexCache = (): void => {
    indexCache.clear()
}

/**
 * Read one skill's post-frontmatter body, on demand. Re-reads and re-parses the file rather than
 * consulting any cache, which is what makes a live edit to a skill visible on the next call.
 */
export const loadSkillBody = async (meta: SkillMeta): Promise<string> => {
    // The index-time size and symlink guards are re-applied here, not trusted from the index. The
    // index is cached for SKILL_INDEX_TTL_MS, so a file can be grown or replaced with a symlink in
    // between; without this the stated 1 MB bound is simply untrue at the moment the body is served.
    const stats = await fs.promises.lstat(meta.absolutePath)
    if (stats.isSymbolicLink()) {
        throw new Error(`Agent Skills: "${meta.folder}/SKILL.md" is a symbolic link and was not read.`)
    }
    if (stats.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Agent Skills: "${meta.folder}/SKILL.md" is ${stats.size} bytes, above the ${MAX_SKILL_FILE_BYTES}-byte limit.`)
    }

    const raw = await fs.promises.readFile(meta.absolutePath, 'utf8')
    const parsed = parseSkillFile(raw)
    if (!parsed.ok) {
        throw new Error(`Agent Skills: "${meta.folder}/SKILL.md" ${parsed.reason}.`)
    }
    return parsed.body
}
