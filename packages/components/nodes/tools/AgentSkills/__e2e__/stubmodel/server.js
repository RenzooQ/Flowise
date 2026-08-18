/*
 * Deterministic OpenAI-compatible chat-completions server, written for the Agent Skills e2e.
 *
 * WHY THIS EXISTS. The e2e needs an endpoint that speaks the OpenAI wire protocol AND returns real
 * `tool_calls`. No API key is available on this machine, and the Claude-subscription bridges wrap the
 * Claude Code *agent* CLI, which carries its own fixed tool set and ignores caller-supplied `tools`
 * (measured: it answered with DesignSync/CronCreate/Monitor and finish_reason "stop").
 *
 * WHAT IT PROVES: that Flowise transmits every skill as a tool definition carrying its frontmatter
 * description, that the Agent dispatches a chosen skill tool, that the Agent Skills node returns the
 * enveloped skill body, and that the body re-enters the model context on the next turn.
 *
 * WHAT IT DOES NOT PROVE: that a real LLM *elects* to call a skill unprompted. Tool selection here is
 * deterministic lexical scoring over the descriptions, not model judgement. Stated plainly so the
 * evidence is not over-read.
 *
 * Zero dependencies: node:http only.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 8756)
const LOG = path.join(__dirname, 'requests.log')
const MODEL_ID = 'agent-skills-e2e-stub-1'

const STOPWORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'for',
    'to',
    'of',
    'in',
    'on',
    'with',
    'use',
    'used',
    'when',
    'that',
    'this',
    'it',
    'is',
    'are',
    'be',
    'you',
    'your',
    'i',
    'me',
    'my',
    'we',
    'our',
    'how',
    'what',
    'do',
    'does',
    'can',
    'should',
    'need',
    'want',
    'please',
    'write',
    'make'
])

const tokenize = (s) =>
    String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))

/** Score a tool against the user's prompt: overlap between prompt tokens and the tool's name+description. */
const scoreTool = (tool, promptTokens) => {
    const fn = tool.function || tool
    const hay = new Set(tokenize(`${fn.name} ${fn.description}`))
    let score = 0
    for (const t of promptTokens) if (hay.has(t)) score++
    // Reward an explicit name mention heavily so a test can force a specific skill.
    const nameWords = tokenize(fn.name)
    if (nameWords.length && nameWords.every((w) => promptTokens.includes(w))) score += 50
    return score
}

const log = (entry) => {
    try {
        fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
        /* evidence logging must never break the server */
    }
}

const send = (res, code, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    res.end(payload)
}

const chatCompletion = (req, res, body) => {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const tools = Array.isArray(body.tools) ? body.tools : []

    // Evidence: exactly what Flowise handed us.
    log({
        at: new Date().toISOString(),
        phase: messages.some((m) => m.role === 'tool') ? 'after-tool-result' : 'initial',
        model_requested: body.model,
        tool_count: tools.length,
        tool_names: tools.map((t) => (t.function || t).name),
        tool_descriptions: Object.fromEntries(tools.map((t) => [(t.function || t).name, (t.function || t).description])),
        message_roles: messages.map((m) => m.role)
    })

    const toolResults = messages.filter((m) => m.role === 'tool')

    // TURN 2: a tool result is present. Answer using it, quoting enough to prove it arrived intact.
    if (toolResults.length > 0) {
        const last = String(toolResults[toolResults.length - 1].content || '')
        const enveloped = last.includes('--- BEGIN SKILL TEXT ---') && last.includes('--- END SKILL TEXT ---')
        const nameMatch = /<agent-skill name="([^"]+)"/.exec(last)
        const inner = last.split('--- BEGIN SKILL TEXT ---')[1] || ''
        const firstHeading = (/^#{1,3}\s+(.+)$/m.exec(inner) || [])[1] || '(none)'
        const answer =
            `I loaded the "${nameMatch ? nameMatch[1] : 'unknown'}" skill and will follow it.\n\n` +
            `Envelope intact: ${enveloped}. Skill text length: ${inner.length} characters. ` +
            `First heading in the skill body: "${firstHeading}".\n\n` +
            `Following those instructions now.`
        log({ at: new Date().toISOString(), phase: 'final-answer', enveloped, skill: nameMatch ? nameMatch[1] : null, chars: inner.length })
        return send(res, 200, {
            id: 'chatcmpl-stub-final',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        })
    }

    // TURN 1: pick the best-matching tool and emit a real tool_calls response.
    const userText = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ')
    const promptTokens = tokenize(userText)

    if (tools.length > 0) {
        const ranked = tools
            .map((t) => ({ tool: t, score: scoreTool(t, promptTokens) }))
            .sort((a, b) => b.score - a.score || (a.tool.function || a.tool).name.localeCompare((b.tool.function || b.tool).name))
        const best = ranked[0]
        if (best && best.score > 0) {
            const fn = best.tool.function || best.tool
            log({
                at: new Date().toISOString(),
                phase: 'tool-selection',
                chosen: fn.name,
                score: best.score,
                runners_up: ranked.slice(1, 4).map((r) => `${(r.tool.function || r.tool).name}:${r.score}`)
            })
            return send(res, 200, {
                id: 'chatcmpl-stub-toolcall',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: MODEL_ID,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_stub_1',
                                    type: 'function',
                                    function: { name: fn.name, arguments: JSON.stringify({ section: '' }) }
                                }
                            ]
                        },
                        finish_reason: 'tool_calls'
                    }
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            })
        }
    }

    return send(res, 200, {
        id: 'chatcmpl-stub-plain',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: `No tool matched. Received ${tools.length} tool definitions.` },
                finish_reason: 'stop'
            }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })
}

const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]

    if (req.method === 'GET' && url === '/health') return send(res, 200, { status: 'ok', provider: 'agent-skills-e2e-stub' })

    if (req.method === 'GET' && url === '/v1/models') {
        return send(res, 200, {
            object: 'list',
            data: [{ id: MODEL_ID, object: 'model', owned_by: 'local-stub', created: Math.floor(Date.now() / 1000) }]
        })
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') {
        let raw = ''
        req.on('data', (c) => {
            raw += c
            if (raw.length > 8 * 1024 * 1024) req.destroy()
        })
        req.on('end', () => {
            let body
            try {
                body = JSON.parse(raw || '{}')
            } catch {
                return send(res, 400, { error: { message: 'invalid JSON body' } })
            }
            try {
                chatCompletion(req, res, body)
            } catch (e) {
                send(res, 500, { error: { message: String(e && e.message) } })
            }
        })
        return
    }

    send(res, 404, { error: { message: `no route for ${req.method} ${url}` } })
})

server.listen(PORT, '127.0.0.1', () => {
    console.info(`[stub] OpenAI-compatible stub listening on http://127.0.0.1:${PORT}/v1  (model: ${MODEL_ID})`)
    console.info(`[stub] request evidence -> ${LOG}`)
})
