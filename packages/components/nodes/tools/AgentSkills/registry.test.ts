import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    buildSkillIndex,
    clearSkillIndexCache,
    getSkillIndex,
    isRemoteOrDevicePath,
    loadSkillBody,
    MAX_SKILL_DIR_ENTRIES,
    MAX_SKILL_FILE_BYTES,
    resolveSkillsDir,
    sanitizeToolName,
    skillsDirCandidates
} from './registry'

const VENDORED_DIR = path.join(__dirname, '..', '..', '..', 'skills-library', 'skills')

/**
 * Malformed fixtures are written into the OS temp dir at run time rather than committed:
 * a committed fixture would be reformatted by the pre-commit `pretty-quick` run, and fixtures
 * for BOM, CRLF and broken frontmatter are defined by their exact bytes.
 */
const tempDirs: string[] = []

const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentskills-'))
    tempDirs.push(dir)
    return dir
}

const writeSkill = (root: string, folder: string, contents: string): void => {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
    fs.writeFileSync(path.join(root, folder, 'SKILL.md'), contents, 'utf8')
}

const validSkill = (name: string, description = `Does ${name} things. Use when you need ${name}.`): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## Overview\n\nBody of ${name}.\n`

let warnSpy: jest.SpyInstance

beforeEach(() => {
    clearSkillIndexCache()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    warnSpy.mockRestore()
    jest.restoreAllMocks()
})

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('AgentSkills registry', () => {
    describe('the vendored library', () => {
        it('indexes exactly 24 skills with zero warnings', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            expect(index.warnings).toEqual([])
            expect(index.skills).toHaveLength(24)
        })

        it('sorts by folder and uses the folder as the primary key', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            const folders = index.skills.map((s) => s.folder)
            expect(folders).toEqual([...folders].sort())
            expect(folders[0]).toBe('api-and-interface-design')
            expect(folders[folders.length - 1]).toBe('using-agent-skills')
        })

        it('keeps the two structurally-exempt skills, warning-free', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            const ideaRefine = index.skills.find((s) => s.folder === 'idea-refine')
            const usingAgentSkills = index.skills.find((s) => s.folder === 'using-agent-skills')
            expect(ideaRefine).toBeDefined()
            expect(usingAgentSkills).toBeDefined()
            // idea-refine has no Overview / When to Use / Common Rationalizations; using-agent-skills
            // is missing four of the five lint sections. Both are valid, shipping skills - the
            // registry requires parseable frontmatter, never body headings.
            expect(ideaRefine?.sections).not.toContain('Overview')
            expect(index.warnings).toEqual([])
        })

        it("never opens idea-refine's three companion .md files, which sit at SKILL.md depth", async () => {
            const companions = fs.readdirSync(path.join(VENDORED_DIR, 'idea-refine')).filter((f) => f.endsWith('.md') && f !== 'SKILL.md')
            expect(companions.sort()).toEqual(['examples.md', 'frameworks.md', 'refinement-criteria.md'])

            const index = await buildSkillIndex(VENDORED_DIR)
            const opened = index.skills.map((s) => path.basename(s.absolutePath))
            expect(new Set(opened)).toEqual(new Set(['SKILL.md']))
            expect(index.skills.filter((s) => s.folder === 'idea-refine')).toHaveLength(1)
        })

        it('leaves all 24 tool names unchanged by sanitisation, with zero collisions', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            for (const skill of index.skills) {
                expect(skill.toolName).toBe(skill.folder)
                expect(skill.toolName).toBe(skill.name)
            }
            expect(new Set(index.skills.map((s) => s.toolName)).size).toBe(24)
        })

        it('holds no bodies in the index and loads them on demand', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            const serialised = JSON.stringify(index)
            expect(serialised).not.toContain('Body of')
            for (const skill of index.skills) {
                expect(Object.keys(skill)).not.toContain('body')
                expect(skill.sizeBytes).toBeGreaterThan(0)
            }
            const body = await loadSkillBody(index.skills.find((s) => s.folder === 'spec-driven-development')!)
            expect(body.startsWith('# Spec-Driven Development')).toBe(true)
            expect(body.length).toBeGreaterThan(1000)
        })

        it('reflects an edit to a skill body on the very next loadSkillBody call', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            const index = await buildSkillIndex(dir)
            const meta = index.skills[0]
            expect(await loadSkillBody(meta)).toContain('Body of alpha')

            fs.writeFileSync(meta.absolutePath, validSkill('alpha').replace('Body of alpha', 'Edited body'), 'utf8')
            expect(await loadSkillBody(meta)).toContain('Edited body')
        })

        it('re-applies the size guard at read time, so a file grown after indexing is refused', async () => {
            // The index is cached for SKILL_INDEX_TTL_MS, so a file can grow between being indexed
            // and having its body served. Checking only at index time makes the stated 1 MB bound
            // untrue at the moment that matters. Measured before the fix: a 3 MB body was served.
            const dir = makeTempDir()
            writeSkill(dir, 'grow', validSkill('grow'))
            const index = await buildSkillIndex(dir)
            const meta = index.skills[0]
            expect(await loadSkillBody(meta)).toContain('Body of grow')

            fs.writeFileSync(meta.absolutePath, `---\nname: grow\ndescription: d\n---\n\n${'X'.repeat(2 * 1024 * 1024)}\n`, 'utf8')
            await expect(loadSkillBody(meta)).rejects.toThrow(/above the .* limit/)
        })
    })

    describe('__dirname probe', () => {
        it('finds the vendored directory from the jest dev-tree location, with no override', async () => {
            const resolved = await resolveSkillsDir()
            expect(resolved).toBe(path.resolve(VENDORED_DIR))
            expect(fs.existsSync(path.join(resolved, 'spec-driven-development', 'SKILL.md'))).toBe(true)
        })

        it('prefers a valid override over the bundled library', async () => {
            const dir = makeTempDir()
            expect(await resolveSkillsDir(dir)).toBe(path.resolve(dir))
        })

        it('does NOT fall back to the bundled library when a given override is unresolvable', async () => {
            // Falling back would silently swap a DIFFERENT instruction set into an agent whose author
            // asked for their own, with only a server-log warning the flow author never sees.
            // Resolving to '' is what makes init() throw with the bad path in the message.
            const missing = path.join(os.tmpdir(), 'agentskills-does-not-exist-x9')
            expect(await resolveSkillsDir(missing)).toBe('')
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('is not a readable directory'))
        })

        it('ignores an empty or whitespace-only override without warning', async () => {
            expect(await resolveSkillsDir('')).toBe(path.resolve(VENDORED_DIR))
            expect(await resolveSkillsDir('   ')).toBe(path.resolve(VENDORED_DIR))
            expect(warnSpy).not.toHaveBeenCalled()
        })
    })

    describe('malformed input resilience', () => {
        it('yields 2 skills and 2 warnings from a dir of 2 good, 1 malformed, 1 empty and 1 loose file', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            writeSkill(dir, 'beta', validSkill('beta'))
            writeSkill(dir, 'broken', '---\nname: [unclosed\n---\n\n# Broken\n')
            fs.mkdirSync(path.join(dir, 'empty-dir'))
            fs.writeFileSync(path.join(dir, 'loose.md'), '# not a skill\n', 'utf8')

            const index = await buildSkillIndex(dir)
            expect(index.skills.map((s) => s.folder)).toEqual(['alpha', 'beta'])
            expect(index.warnings).toHaveLength(2)
            expect(index.warnings.join('\n')).toContain('broken')
            expect(index.warnings.join('\n')).toContain('empty-dir')
        })

        it('refuses a symlinked SKILL.md, the way it already refuses a symlinked directory', async () => {
            // stat() follows symlinks; lstat() does not. Without lstat, <skill>/SKILL.md could point
            // at any file on disk and its contents would be handed to the model. Skipped where the
            // OS refuses symlink creation (Windows without developer mode) rather than failing.
            const dir = makeTempDir()
            writeSkill(dir, 'normal', validSkill('normal'))
            const target = path.join(dir, 'elsewhere.md')
            fs.writeFileSync(target, validSkill('elsewhere'), 'utf8')
            fs.mkdirSync(path.join(dir, 'sneaky'))
            try {
                fs.symlinkSync(target, path.join(dir, 'sneaky', 'SKILL.md'), 'file')
            } catch {
                return // no symlink privilege on this host
            }

            const index = await buildSkillIndex(dir)
            expect(index.skills.map((s) => s.folder)).toEqual(['normal'])
            expect(index.warnings.join('\n')).toContain('symbolic link')
        })

        it('returns an empty index and a warning for a non-existent directory, without throwing', async () => {
            const missing = path.join(os.tmpdir(), 'agentskills-nope-4711', 'skills')
            const index = await buildSkillIndex(missing)
            expect(index.skills).toEqual([])
            expect(index.warnings).toHaveLength(1)
            expect(index.warnings[0]).toContain('could not be read')
        })

        it('returns an empty index and a warning when no directory resolves at all', async () => {
            const index = await buildSkillIndex('')
            expect(index.skills).toEqual([])
            expect(index.warnings).toEqual(['no skills directory could be resolved'])
        })

        it('skips dot-directories', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            writeSkill(dir, '.hidden', validSkill('hidden'))
            const index = await buildSkillIndex(dir)
            expect(index.skills.map((s) => s.folder)).toEqual(['alpha'])
            expect(index.warnings).toEqual([])
        })

        it('skips a SKILL.md above the 1 MB limit, with a warning', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            const huge = `---\nname: huge\ndescription: huge\n---\n\n# Huge\n\n${'x'.repeat(1_500_000)}\n`
            expect(huge.length).toBeGreaterThan(MAX_SKILL_FILE_BYTES)
            writeSkill(dir, 'huge', huge)

            const index = await buildSkillIndex(dir)
            expect(index.skills.map((s) => s.folder)).toEqual(['alpha'])
            expect(index.warnings.join('\n')).toContain('above the 1048576-byte limit')
        })

        it('stops at 500 entries in a 501-entry directory, with a warning', async () => {
            const dir = makeTempDir()
            for (let i = 0; i < 501; i++) {
                writeSkill(dir, `skill-${String(i).padStart(4, '0')}`, validSkill(`skill-${String(i).padStart(4, '0')}`))
            }
            const index = await buildSkillIndex(dir)
            expect(index.skills).toHaveLength(MAX_SKILL_DIR_ENTRIES)
            expect(index.warnings.join('\n')).toContain('only the first 500 are scanned')
        })

        it('surfaces a skip reason rather than throwing when a directory has no SKILL.md', async () => {
            const dir = makeTempDir()
            fs.mkdirSync(path.join(dir, 'no-skill-here'))
            fs.writeFileSync(path.join(dir, 'no-skill-here', 'README.md'), '# nope\n', 'utf8')
            const index = await buildSkillIndex(dir)
            expect(index.skills).toEqual([])
            expect(index.warnings).toEqual(['"no-skill-here" has no SKILL.md; skipped'])
        })

        it('indexes a skill whose body is empty, but warns that its tool will return nothing', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            writeSkill(dir, 'hollow', '---\nname: hollow\ndescription: Valid frontmatter, no body.\n---\n')
            writeSkill(dir, 'whitespace', '---\nname: whitespace\ndescription: Body is whitespace only.\n---\n\n   \n\t\n')

            const index = await buildSkillIndex(dir)
            // Kept, not dropped: silently removing a skill the user selected on purpose is more
            // surprising than exposing a thin one. The warning is what makes it debuggable.
            expect(index.skills.map((s) => s.folder)).toEqual(['alpha', 'hollow', 'whitespace'])
            expect(index.warnings).toEqual([
                '"hollow/SKILL.md" has no body after its frontmatter; the tool will return an empty payload',
                '"whitespace/SKILL.md" has no body after its frontmatter; the tool will return an empty payload'
            ])
            expect(await loadSkillBody(index.skills[1])).toBe('')
        })

        it('does not warn about an empty body for any of the 24 vendored skills', async () => {
            const index = await buildSkillIndex(VENDORED_DIR)
            expect(index.warnings.filter((w) => w.includes('no body after its frontmatter'))).toEqual([])
        })
    })

    describe('tool-name sanitisation and de-duplication', () => {
        it('handles synthetic hostile names deterministically', () => {
            expect(sanitizeToolName('Über Skill!!', 0)).toBe('ber_skill')
            expect(sanitizeToolName('', 3)).toBe('skill_3')
            expect(sanitizeToolName('!!!', 7)).toBe('skill_7')
            expect(sanitizeToolName('Path/Traversal../x', 0)).toBe('pathtraversalx')
            expect(sanitizeToolName('a'.repeat(80), 0)).toHaveLength(64)
        })

        it('de-duplicates two 80-char names that share their first 64 characters', async () => {
            const dir = makeTempDir()
            const base = 'x'.repeat(64)
            writeSkill(dir, 'first', validSkill(`${base}aaaaaaaaaaaaaaaa`))
            writeSkill(dir, 'second', validSkill(`${base}bbbbbbbbbbbbbbbb`))

            const index = await buildSkillIndex(dir)
            const names = index.skills.map((s) => s.toolName)
            expect(names[0]).toBe(base)
            expect(names[1]).toBe(`${'x'.repeat(62)}_2`)
            expect(names[1]).toHaveLength(64)
            expect(new Set(names).size).toBe(2)
        })

        it('assigns de-duplication suffixes in folder sort order, so they are reproducible', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'zebra', validSkill('duplicate'))
            writeSkill(dir, 'alpha', validSkill('duplicate'))
            writeSkill(dir, 'mango', validSkill('duplicate'))

            const first = await buildSkillIndex(dir)
            const second = await buildSkillIndex(dir)
            expect(first.skills.map((s) => [s.folder, s.toolName])).toEqual([
                ['alpha', 'duplicate'],
                ['mango', 'duplicate_2'],
                ['zebra', 'duplicate_3']
            ])
            expect(second.skills.map((s) => s.toolName)).toEqual(first.skills.map((s) => s.toolName))
        })

        it('falls back to skill_<index> for a name that sanitises to nothing', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            // Quoted, because a bare "!!!" is a YAML tag and would be a parse failure instead.
            writeSkill(dir, 'symbols', '---\nname: "!!!"\ndescription: Symbols only.\n---\n\n# Symbols\n\nBody.\n')
            const index = await buildSkillIndex(dir)
            expect(index.skills.map((s) => s.toolName)).toEqual(['alpha', 'skill_1'])
        })
    })

    describe('TTL cache', () => {
        it('reads the directory once for two getSkillIndex calls inside the TTL', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            const readFileSpy = jest.spyOn(fs.promises, 'readFile')

            const first = await getSkillIndex(dir)
            const callsAfterFirst = readFileSpy.mock.calls.length
            expect(callsAfterFirst).toBeGreaterThan(0)

            const second = await getSkillIndex(dir)
            expect(readFileSpy.mock.calls.length).toBe(callsAfterFirst)
            expect(second).toBe(first)
        })

        it('re-reads after clearSkillIndexCache()', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'alpha', validSkill('alpha'))
            const readFileSpy = jest.spyOn(fs.promises, 'readFile')

            const first = await getSkillIndex(dir)
            const callsAfterFirst = readFileSpy.mock.calls.length
            clearSkillIndexCache()
            const second = await getSkillIndex(dir)

            expect(readFileSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst)
            expect(second).not.toBe(first)
            expect(second.skills.map((s) => s.folder)).toEqual(first.skills.map((s) => s.folder))
        })

        it('keys the cache on the resolved directory, so two directories do not share an entry', async () => {
            const a = makeTempDir()
            const b = makeTempDir()
            writeSkill(a, 'alpha', validSkill('alpha'))
            writeSkill(b, 'beta', validSkill('beta'))

            expect((await getSkillIndex(a)).skills.map((s) => s.folder)).toEqual(['alpha'])
            expect((await getSkillIndex(b)).skills.map((s) => s.folder)).toEqual(['beta'])
        })

        it('emits each warning through console.warn with the [AgentSkills] prefix', async () => {
            const dir = makeTempDir()
            writeSkill(dir, 'broken', '---\nname: [unclosed\n---\n\n# Broken\n')
            await getSkillIndex(dir)
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[AgentSkills] .*broken/))
        })
    })

    describe('index cache is bounded (code review finding 4)', () => {
        // The key is a caller-supplied path reaching here from the Skills Directory input via
        // POST /api/v1/node-load-method, and the TTL rebuilds entries but never removes them, so
        // an unbounded map would grow one entry per distinct path named, for the process lifetime.
        it('evicts the oldest entries beyond MAX_CACHED_INDEXES', async () => {
            clearSkillIndexCache()
            const dirs: string[] = []
            for (let n = 0; n < 20; n++) {
                const d = makeTempDir()
                writeSkill(d, 'alpha', validSkill('alpha'))
                dirs.push(d)
                await getSkillIndex(d)
            }
            // The first directories indexed must no longer be cached; the most recent must be.
            const readsFor = async (dir: string): Promise<number> => {
                const spy = jest.spyOn(fs.promises, 'readdir')
                await getSkillIndex(dir)
                const n = spy.mock.calls.length
                spy.mockRestore()
                return n
            }
            expect(await readsFor(dirs[19])).toBe(0)
            expect(await readsFor(dirs[0])).toBeGreaterThan(0)
        })
    })

    describe('UNC and device paths are refused before any filesystem call', () => {
        // The Skills Directory input reaches resolveSkillsDir from any flow editor. path.resolve and
        // path.join preserve a UNC prefix verbatim, so an unchecked value would be handed to fs.stat
        // and, on Windows, make the SMB redirector authenticate outbound as the service account.
        const refused = [
            '\\\\attacker.example\\share\\skills',
            '\\\\?\\C:\\Windows',
            '\\\\.\\pipe\\something',
            '//attacker.example/share/skills',
            '\\/mixed/separators'
        ]

        it.each(refused)('classifies %j as remote or device', (candidate) => {
            expect(isRemoteOrDevicePath(candidate)).toBe(true)
        })

        it.each(['C:\\Users\\me\\skills', '/home/me/skills', './relative/skills', 'skills'])(
            'leaves ordinary path %j alone',
            (candidate) => {
                expect(isRemoteOrDevicePath(candidate)).toBe(false)
            }
        )

        it('returns "" for a UNC override without ever touching the filesystem', async () => {
            const statSpy = jest.spyOn(fs.promises, 'stat')
            expect(await resolveSkillsDir('\\\\attacker.example\\share\\skills')).toBe('')
            // The point of the guard is that no connection attempt happens at all.
            expect(statSpy).not.toHaveBeenCalled()
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UNC or device path'))
            statSpy.mockRestore()
        })

        it('makes init() fail visibly rather than silently serving the bundled skills', async () => {
            // Falling back to the bundled library would hand the agent a DIFFERENT instruction set
            // than the flow author asked for, with only a server-log line to say so.
            const index = await getSkillIndex('\\\\attacker.example\\share\\skills')
            expect(index.skills).toHaveLength(0)
        })
    })

    describe('loadSkillBody reads through one descriptor', () => {
        // Windows refuses symlink creation without elevation or developer mode (measured: EPERM on
        // this host), so these skip rather than fail there. They are the assertions that matter on
        // Linux CI, which is where the product actually runs.
        const canSymlink = (() => {
            try {
                const probe = makeTempDir()
                fs.writeFileSync(path.join(probe, 'target'), 'x')
                fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'))
                return true
            } catch {
                return false
            }
        })()

        const symlinkIt = canSymlink ? it : it.skip

        symlinkIt('refuses a SKILL.md that is a symbolic link, even to a valid skill', async () => {
            // The refusal must be on the PATH: once a descriptor is open it refers to the target, so
            // fstat reports an ordinary regular file. Checking only the handle would silently stop
            // refusing symlinks — this is that regression's test.
            const dir = makeTempDir()
            const real = makeTempDir()
            fs.writeFileSync(path.join(real, 'elsewhere.md'), validSkill('elsewhere'))
            fs.mkdirSync(path.join(dir, 'linked'))
            fs.symlinkSync(path.join(real, 'elsewhere.md'), path.join(dir, 'linked', 'SKILL.md'))

            await expect(
                loadSkillBody({
                    folder: 'linked',
                    name: 'linked',
                    description: 'd',
                    title: '',
                    absolutePath: path.join(dir, 'linked', 'SKILL.md'),
                    sections: [],
                    sizeBytes: 10,
                    toolName: 'linked'
                })
            ).rejects.toThrow(/symbolic link/)
        })

        it('refuses a symlink on every platform, including where one cannot be created', async () => {
            // The real-symlink test above skips on Windows, and a skipped test guarantees nothing on
            // the host you are actually developing on. This drives the same branch by making lstat
            // report a link, so the guard is verified everywhere the suite runs.
            const dir = makeTempDir()
            writeSkill(dir, 'pretend', validSkill('pretend'))
            const absolutePath = path.join(dir, 'pretend', 'SKILL.md')

            const realLstat = fs.promises.lstat
            const lstatSpy = jest.spyOn(fs.promises, 'lstat').mockImplementation(async (target) => {
                const stats = await realLstat(target as string)
                if (String(target) === absolutePath) {
                    // Same stats object, one answer changed: this is the only lie in the test.
                    Object.defineProperty(stats, 'isSymbolicLink', { value: () => true })
                }
                return stats
            })
            const openSpy = jest.spyOn(fs.promises, 'open')

            await expect(
                loadSkillBody({
                    folder: 'pretend',
                    name: 'pretend',
                    description: 'd',
                    title: '',
                    absolutePath,
                    sections: [],
                    sizeBytes: 10,
                    toolName: 'pretend'
                })
            ).rejects.toThrow(/symbolic link/)

            // The refusal must happen BEFORE the file is opened; otherwise the descriptor already
            // refers to the target and fstat can no longer tell.
            expect(openSpy).not.toHaveBeenCalled()

            lstatSpy.mockRestore()
            openSpy.mockRestore()
        })

        it('reports a vanished file by skill name, without leaking the server path', async () => {
            const dir = makeTempDir()
            const absolutePath = path.join(dir, 'gone', 'SKILL.md')
            await expect(
                loadSkillBody({
                    folder: 'gone',
                    name: 'gone',
                    description: 'd',
                    title: '',
                    absolutePath,
                    sections: [],
                    sizeBytes: 10,
                    toolName: 'gone'
                })
            ).rejects.toThrow(/"gone\/SKILL\.md" could not be read/)

            // The message reaches a chat end user, so it must not carry the absolute server path.
            await loadSkillBody({
                folder: 'gone',
                name: 'gone',
                description: 'd',
                title: '',
                absolutePath,
                sections: [],
                sizeBytes: 10,
                toolName: 'gone'
            }).catch((e: Error) => {
                expect(e.message).not.toContain(dir)
            })
        })

        it('serves the body it measured when the file is replaced mid-call', async () => {
            // The point of reading through the descriptor: content cannot be swapped between the
            // size check and the read.
            const dir = makeTempDir()
            writeSkill(dir, 'stable', validSkill('stable'))
            const meta = {
                folder: 'stable',
                name: 'stable',
                description: 'd',
                title: '',
                absolutePath: path.join(dir, 'stable', 'SKILL.md'),
                sections: [],
                sizeBytes: 10,
                toolName: 'stable'
            }
            const body = await loadSkillBody(meta)
            expect(body).toContain('Body of stable.')
        })
    })

    describe('built-tree resolution (the candidate no test used to reach)', () => {
        // Under jest __dirname is the source layout, so the first candidate always hits and the
        // built-tree entry is never evaluated. Deleting it would leave every test green and every
        // built install throwing "no skills found", so it is asserted directly here.
        const subpath = path.join('skills-library', 'skills')

        it('resolves the vendored library from the SOURCE layout', () => {
            const base = path.join('/repo', 'packages', 'components', 'nodes', 'tools', 'AgentSkills')
            const expected = path.resolve(path.join('/repo', 'packages', 'components', subpath))
            expect(skillsDirCandidates(base).map((c) => path.resolve(c))).toContain(expected)
        })

        it('resolves the vendored library from the BUILT layout', () => {
            const base = path.join('/repo', 'packages', 'components', 'dist', 'nodes', 'tools', 'AgentSkills')
            const expected = path.resolve(path.join('/repo', 'packages', 'components', subpath))
            expect(skillsDirCandidates(base).map((c) => path.resolve(c))).toContain(expected)
        })

        it('actually finds the real bundled library on disk from this module location', async () => {
            const resolved = await resolveSkillsDir()
            expect(resolved).not.toBe('')
            expect(fs.existsSync(path.join(resolved, 'using-agent-skills', 'SKILL.md'))).toBe(true)
        })
    })
})
