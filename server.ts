#!/usr/bin/env bun
/**
 * Phone4.ai voice channel for Claude Code.
 *
 * MCP server that bridges Phone4.ai voice calls into Claude Code sessions.
 * Uses a long-poll tool (phone_listen) since MCP channel notifications
 * are only supported for marketplace-published plugins.
 *
 * Runs two roles in one process:
 * 1. HTTP webhook server (port 7600) — receives call events from Phone4.ai
 * 2. MCP stdio server — communicates with Claude Code via stdin/stdout
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import { readFileSync, appendFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import ngrok from '@ngrok/ngrok'

const LOG_FILE = join(homedir(), '.claude', 'channels', 'phone4ai', 'debug.log')
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(`phone4ai: ${msg}\n`)
  try { appendFileSync(LOG_FILE, line) } catch {}
}

// ── State directory ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.PHONE4AI_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'phone4ai')
const ENV_FILE = join(STATE_DIR, '.env')

// Load .env — plugin-spawned servers don't get env blocks.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
} catch {}

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PHONE_WEBHOOK_PORT || '7600', 10)
const PHONE4AI_API = process.env.PHONE4AI_API || 'https://api.phone4.ai'
const PHONE4AI_NUMBER = process.env.PHONE4AI_NUMBER || ''

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || ''
const TTS_ENABLED = !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID)

const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || ''
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || ''

// How long to wait for Claude before sending filler (ms).
// Phone4.ai relay has 12s timeout; we need margin for TTS generation + network.
const RESPONSE_TIMEOUT_MS = 10000

// How long phone_listen blocks before returning empty (ms).
const LISTEN_TIMEOUT_MS = 30000

// ── Safety nets ──────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  process.stderr.write(`phone4ai: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`phone4ai: uncaught exception: ${err}\n`)
})

// ── ElevenLabs TTS ───────────────────────────────────────────────────────────

const audioCache = new Map<string, Buffer>()

async function textToSpeech(text: string): Promise<string | null> {
  if (!TTS_ENABLED) return null
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    )
    if (!resp.ok) {
      process.stderr.write(`phone4ai: ElevenLabs error ${resp.status}\n`)
      return null
    }
    const buffer = Buffer.from(await resp.arrayBuffer())
    const id = randomUUID()
    audioCache.set(id, buffer)
    setTimeout(() => audioCache.delete(id), 60_000)
    return id
  } catch (err) {
    process.stderr.write(`phone4ai: TTS error: ${err}\n`)
    return null
  }
}

// ── Pending response queue ───────────────────────────────────────────────────
// Bridges the async gap between webhook requests and Claude's tool calls.

type PendingCall = {
  resolve: (response: CallResponse) => void
  timer: ReturnType<typeof setTimeout>
  callId: string
  from: string
}

type CallResponse = {
  action: 'gather' | 'say'
  text: string
  audioUrl?: string
  timeoutSec?: number
  bargeIn?: boolean
}

// One pending request per call_id. Webhook POST sets it, phone_respond resolves it.
const pending = new Map<string, PendingCall>()

// Queued responses: if Claude responds after the filler was already sent,
// queue it for the next webhook turn.
const queued = new Map<string, CallResponse>()

function resolveCall(callId: string, response: CallResponse) {
  const p = pending.get(callId)
  if (p) {
    clearTimeout(p.timer)
    pending.delete(callId)
    log(`Claude responded for call ${callId}: "${response.text}"`)
    p.resolve(response)
  } else {
    // Claude responded after timeout — queue for next turn
    log(`Claude responded LATE for call ${callId} — queued for next turn`)
    queued.set(callId, response)
  }
}

// ── Event queue for long-poll ────────────────────────────────────────────────
// Webhook pushes events here; phone_listen pops them.

type CallEvent = {
  call_id: string
  type: string
  from: string
  content: string
  ts: string
}

const eventQueue: CallEvent[] = []
let eventWaiter: ((event: CallEvent) => void) | null = null

function pushEvent(event: CallEvent) {
  if (eventWaiter) {
    // phone_listen is waiting — deliver immediately
    const waiter = eventWaiter
    eventWaiter = null
    waiter(event)
  } else {
    eventQueue.push(event)
  }
}

function waitForEvent(timeoutMs: number): Promise<CallEvent | null> {
  // Check queue first
  if (eventQueue.length > 0) {
    return Promise.resolve(eventQueue.shift()!)
  }
  // Block until an event arrives or timeout
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      eventWaiter = null
      resolve(null)
    }, timeoutMs)
    eventWaiter = (event) => {
      clearTimeout(timer)
      resolve(event)
    }
  })
}

// Track whether phone_listen has been called recently
let lastListenTime = 0

function hasActiveListener(): boolean {
  return Date.now() - lastListenTime < 60_000
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'phone4ai', version: '0.0.2' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Phone4.ai voice channel — you can receive and make real phone calls.',
      '',
      'HOW IT WORKS: Call phone_listen to wait for incoming call events. When an event arrives, respond with phone_respond, then IMMEDIATELY call phone_listen again to catch the next event. Never stop the listen loop during an active call.',
      '',
      'EVENT TYPES:',
      '- call_start: New incoming call. Greet the caller warmly.',
      '- speech: Caller said something (transcribed text in content). Respond naturally.',
      '- no_input: Silence detected. Gently re-prompt or ask if they\'re still there.',
      '- call_end: Call is over. Stop listening or wait for the next call.',
      '',
      'CRITICAL: The caller is waiting in REAL TIME. You have about 10 seconds to respond before they hear a filler message. Respond FAST — keep it short.',
      '',
      'Voice rules — the caller HEARS your text as speech:',
      '- Be concise: 1-3 sentences per turn.',
      '- Be natural: use contractions ("I\'ll" not "I will").',
      '- No formatting: no markdown, no bullets, no links, no code blocks.',
      '- No emoji: TTS reads them literally.',
      '- Spell out symbols: "dollars" not "$", "percent" not "%".',
      '- One question at a time.',
      '- Stay under 500 characters.',
      '- Set hangup=true on phone_respond when the conversation is naturally over.',
      '',
      'For outbound calls, use phone_call with the destination number.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'phone_listen',
      description:
        'Wait for the next phone call event. Blocks up to 30 seconds. Returns the event (call_start, speech, no_input, call_end) or null if no event arrives. ALWAYS call this again after responding to keep the conversation going.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'phone_respond',
      description:
        'Reply to a phone caller. Text is spoken aloud via TTS. Keep it concise — 1-3 sentences, under 500 chars. No markdown, no emoji. Set hangup=true to end the call.',
      inputSchema: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: 'The call_id from the phone_listen event.',
          },
          text: {
            type: 'string',
            description: 'What to say to the caller. Max 500 chars. Will be spoken aloud.',
          },
          hangup: {
            type: 'boolean',
            description: 'If true, end the call after speaking this text.',
          },
        },
        required: ['call_id', 'text'],
      },
    },
    {
      name: 'phone_call',
      description:
        'Make an outbound phone call. Omit "say" for a multi-turn conversation. Include "say" for a one-shot message.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'E.164 phone number to call (e.g., +15551234567).',
          },
          say: {
            type: 'string',
            description: 'Optional one-shot message. If omitted, starts a multi-turn conversation.',
          },
        },
        required: ['to'],
      },
    },
    {
      name: 'phone_hangup',
      description: 'End an active call immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: 'The call_id of the call to end.',
          },
        },
        required: ['call_id'],
      },
    },
    {
      name: 'phone_status',
      description:
        'Check Phone4.ai account status — active number, subscription status, minutes used.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'phone_listen': {
        lastListenTime = Date.now()
        log('phone_listen called — waiting for event...')
        const event = await waitForEvent(LISTEN_TIMEOUT_MS)
        if (!event) {
          log('phone_listen timed out — no events')
          return {
            content: [{ type: 'text', text: JSON.stringify({ event: null, message: 'No events in 30s. Call phone_listen again to keep waiting.' }) }],
          }
        }
        log(`phone_listen returning event: [${event.type}] ${event.content}`)
        return {
          content: [{ type: 'text', text: JSON.stringify(event) }],
        }
      }

      case 'phone_respond': {
        const callId = args.call_id as string
        let text = args.text as string
        const hangup = args.hangup as boolean | undefined

        if (text.length > 500) text = text.substring(0, 497) + '...'

        // Generate TTS audio
        const audioId = await textToSpeech(text)
        const audioUrl = audioId ? `http://127.0.0.1:${PORT}/audio/${audioId}` : undefined

        const response: CallResponse = hangup
          ? { action: 'say', text, audioUrl }
          : { action: 'gather', text, audioUrl, timeoutSec: 5, bargeIn: true }

        resolveCall(callId, response)

        return {
          content: [{ type: 'text', text: hangup ? `Ending call: "${text}"` : `Replied: "${text}"` }],
        }
      }

      case 'phone_call': {
        const to = args.to as string
        const say = args.say as string | undefined

        if (!PHONE4AI_NUMBER) {
          return {
            content: [{ type: 'text', text: 'Error: PHONE4AI_NUMBER not configured.' }],
            isError: true,
          }
        }

        const body: Record<string, string> = { number: PHONE4AI_NUMBER, to }
        if (say) body.say = say

        const resp = await fetch(`${PHONE4AI_API}/v1/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const result = await resp.json() as Record<string, unknown>

        if (!resp.ok) {
          return {
            content: [{ type: 'text', text: `Call failed: ${result.message || resp.statusText}` }],
            isError: true,
          }
        }

        return {
          content: [{ type: 'text', text: say ? `One-shot call to ${to}: "${say}"` : `Calling ${to}... Use phone_listen to handle the conversation.` }],
        }
      }

      case 'phone_hangup': {
        const callId = args.call_id as string
        resolveCall(callId, { action: 'say', text: 'Goodbye.' })
        return {
          content: [{ type: 'text', text: `Ended call ${callId}` }],
        }
      }

      case 'phone_status': {
        if (!PHONE4AI_NUMBER) {
          return {
            content: [{ type: 'text', text: 'Phone4.ai number not configured.' }],
          }
        }

        try {
          const resp = await fetch(
            `${PHONE4AI_API}/v1/status?humanPhone=${encodeURIComponent(PHONE4AI_NUMBER)}`,
          )
          const result = await resp.json()
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error checking status: ${err}` }],
            isError: true,
          }
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err}` }],
      isError: true,
    }
  }
})

// ── HTTP Webhook Server ──────────────────────────────────────────────────────

const httpServer = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)

    // Serve cached TTS audio for Twilio to fetch
    if (request.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const id = url.pathname.slice(7)
      const audio = audioCache.get(id)
      if (audio) {
        return new Response(audio, {
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) },
        })
      }
      return new Response('Not found', { status: 404 })
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, tts: TTS_ENABLED })
    }

    // Phone4.ai webhook
    if (request.method === 'POST') {
      try {
        const body = await request.json() as {
          call_id: string
          type: string
          speech?: string
          from?: string
          to?: string
          duration?: number
        }

        const { call_id, type, speech, from } = body

        // If call ended, clean up and push event
        if (type === 'call_end') {
          pending.delete(call_id)
          queued.delete(call_id)
          pushEvent({
            call_id,
            type: 'call_end',
            from: from ?? '',
            content: `[Call ended${body.duration ? ` — ${body.duration}s` : ''}]`,
            ts: new Date().toISOString(),
          })
          return Response.json({ action: 'say', text: '' })
        }

        // If no active listener, tell caller Claude isn't available
        if (!hasActiveListener()) {
          log(`NO LISTENER — rejecting call ${call_id} from ${from}`)
          return Response.json({
            action: 'say',
            text: "I'm sorry, no one is available right now. Please try again later.",
          })
        }

        // Check if we have a queued response from a previous timeout
        const queuedResponse = queued.get(call_id)
        if (queuedResponse) {
          queued.delete(call_id)

          // Still push event so Claude knows what was said
          const content = type === 'call_start'
            ? `[Incoming phone call from ${from}]`
            : type === 'no_input'
              ? '[The caller is silent — no speech detected]'
              : speech || '[empty speech]'

          pushEvent({ call_id, type, from: from ?? '', content, ts: new Date().toISOString() })

          return Response.json(queuedResponse)
        }

        // Build event content
        const content = type === 'call_start'
          ? `[Incoming phone call from ${from}]`
          : type === 'no_input'
            ? '[The caller is silent — no speech detected]'
            : speech || '[empty speech]'

        log(`WEBHOOK [${type}] from=${from} call_id=${call_id} content="${content}"`)

        // Push event to queue (wakes up phone_listen if it's waiting)
        pushEvent({ call_id, type, from: from ?? '', content, ts: new Date().toISOString() })

        // Create a promise that resolves when Claude responds (or timeout)
        const responsePromise = new Promise<CallResponse>(resolve => {
          const timer = setTimeout(async () => {
            log(`TIMEOUT — Claude didn't respond in ${RESPONSE_TIMEOUT_MS}ms for call ${call_id}`)
            pending.delete(call_id)
            const fillerText = type === 'call_start'
              ? 'Hello! Give me just a moment.'
              : 'Hmm, one moment...'

            const audioId = await textToSpeech(fillerText)
            const audioUrl = audioId ? `http://127.0.0.1:${PORT}/audio/${audioId}` : undefined

            resolve({
              action: 'gather',
              text: fillerText,
              audioUrl,
              timeoutSec: 8,
              bargeIn: true,
            })
          }, RESPONSE_TIMEOUT_MS)

          pending.set(call_id, { resolve, timer, callId: call_id, from: from ?? '' })
        })

        // Wait for Claude's response or timeout
        const response = await responsePromise
        return Response.json(response)
      } catch (err) {
        process.stderr.write(`phone4ai: webhook error: ${err}\n`)
        return Response.json(
          { action: 'gather', text: 'Sorry, something went wrong.', timeoutSec: 5, bargeIn: true },
          { status: 200 },
        )
      }
    }

    return new Response('Method not allowed', { status: 405 })
  },
})

process.stderr.write(`phone4ai: webhook listening on :${PORT}\n`)
if (TTS_ENABLED) {
  process.stderr.write(`phone4ai: ElevenLabs TTS enabled (voice: ${ELEVENLABS_VOICE_ID})\n`)
} else {
  process.stderr.write(`phone4ai: TTS disabled — using Twilio built-in TTS\n`)
}
if (PHONE4AI_NUMBER) {
  process.stderr.write(`phone4ai: number: ${PHONE4AI_NUMBER}\n`)
} else {
  process.stderr.write(`phone4ai: no PHONE4AI_NUMBER set — outbound calls disabled\n`)
}

// ── ngrok tunnel ──────────────────────────────────────────────────────────────

let tunnelUrl = ''

if (NGROK_AUTHTOKEN && NGROK_DOMAIN) {
  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: NGROK_AUTHTOKEN,
      domain: NGROK_DOMAIN,
    })
    tunnelUrl = listener.url() ?? ''
    log(`ngrok tunnel up: ${tunnelUrl}`)
  } catch (err) {
    log(`ngrok failed to start: ${err}`)
    process.stderr.write(`phone4ai: ngrok failed — calls won't reach this server. Check NGROK_AUTHTOKEN and NGROK_DOMAIN.\n`)
  }
} else {
  process.stderr.write(`phone4ai: ngrok not configured — set NGROK_AUTHTOKEN + NGROK_DOMAIN in ${ENV_FILE}\n`)
  process.stderr.write(`phone4ai: webhook will only be reachable at http://localhost:${PORT}\n`)
}

// ── Webhook URL registration ──────────────────────────────────────────────────

if (tunnelUrl && PHONE4AI_NUMBER) {
  try {
    const resp = await fetch(`${PHONE4AI_API}/v1/status?humanPhone=${encodeURIComponent(PHONE4AI_NUMBER)}`)
    const status = await resp.json() as { status?: string; number?: string }

    if (status.status === 'active' && status.number) {
      log(`Phone4.ai number: ${status.number}, tunnel: ${tunnelUrl}`)
      process.stderr.write(`phone4ai: tunnel ${tunnelUrl} → ready for calls to ${status.number}\n`)
    } else {
      process.stderr.write(`phone4ai: account not active — visit https://api.phone4.ai/account to set up\n`)
    }
  } catch (err) {
    log(`Failed to check Phone4.ai status: ${err}`)
  }
}

// ── MCP transport ────────────────────────────────────────────────────────────

log('MCP server starting...')
const transport = new StdioServerTransport()
await mcp.connect(transport)
log('MCP server connected to Claude Code')
