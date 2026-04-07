#!/usr/bin/env bun
/**
 * Phone4.ai voice channel for Claude Code.
 *
 * MCP server that bridges Phone4.ai voice calls into Claude Code sessions.
 * Connects to api.phone4.ai via WebSocket — no tunnel required.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const PHONE4AI_API = process.env.PHONE4AI_API || 'https://api.phone4.ai'
const PHONE4AI_WS = PHONE4AI_API.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/agent'
const PHONE4AI_KEY = process.env.PHONE4AI_KEY || ''
const PHONE4AI_NUMBER = process.env.PHONE4AI_NUMBER || ''

const LISTEN_TIMEOUT_MS = 30000

function log(msg: string) {
  process.stderr.write(`phone4ai: ${msg}\n`)
}

// ── Safety nets ──────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  process.stderr.write(`phone4ai: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`phone4ai: uncaught exception: ${err}\n`)
})

// ── Event queue for long-poll ────────────────────────────────────────────────

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
    const waiter = eventWaiter
    eventWaiter = null
    waiter(event)
  } else {
    eventQueue.push(event)
  }
}

function waitForEvent(timeoutMs: number): Promise<CallEvent | null> {
  if (eventQueue.length > 0) {
    return Promise.resolve(eventQueue.shift()!)
  }
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

let lastListenTime = 0
function hasActiveListener(): boolean {
  return Date.now() - lastListenTime < 60_000
}

// ── WebSocket connection ─────────────────────────────────────────────────────

let ws: WebSocket | null = null
let wsReady = false
let reconnectDelay = 1000

function connectWebSocket() {
  if (!PHONE4AI_KEY) {
    log('PHONE4AI_KEY not set — cannot connect')
    return
  }

  log(`connecting to ${PHONE4AI_WS}...`)
  ws = new WebSocket(PHONE4AI_WS)

  ws.onopen = () => {
    log('WebSocket connected, authenticating...')
    ws!.send(JSON.stringify({ type: 'auth', key: PHONE4AI_KEY }))
  }

  ws.onmessage = (event) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }

    if (msg.type === 'auth_ok') {
      wsReady = true
      reconnectDelay = 1000
      log(`authenticated — listening on ${msg.number}`)
      return
    }

    if (msg.type === 'auth_error') {
      log(`auth failed: ${msg.message}`)
      wsReady = false
      ws?.close()
      return
    }

    // Call events from server
    if (msg.id && msg.type) {
      const eventType = String(msg.type)
      const callId = String(msg.call_id || '')
      const from = String(msg.from || '')
      const speech = String(msg.speech || '')

      // Check for queued late response — send it immediately as reply to this event
      const queued = queuedResponses.get(callId)
      if (queued && eventType !== 'call_end') {
        log(`Sending queued response for call ${callId}: "${queued.text}"`)
        ws!.send(JSON.stringify({
          reply_to: String(msg.id),
          action: queued.hangup ? 'say' : 'gather',
          text: queued.text,
          timeoutSec: queued.hangup ? undefined : 5,
          bargeIn: queued.hangup ? undefined : true,
        }))
        queuedResponses.delete(callId)
        // Don't store message ID — we consumed it for the queued response
      } else if (eventType !== 'call_end') {
        // Store message ID for phone_respond
        lastMessageIds.set(callId, String(msg.id))
      }

      // Clean up on call end
      if (eventType === 'call_end') {
        lastMessageIds.delete(callId)
        queuedResponses.delete(callId)
      }

      const content = eventType === 'call_start'
        ? `[Incoming phone call from ${from}]`
        : eventType === 'call_end'
          ? `[Call ended${msg.duration ? ` — ${msg.duration}s` : ''}]`
          : eventType === 'no_input'
            ? '[The caller is silent — no speech detected]'
            : speech || '[empty speech]'

      log(`[${eventType}] from=${from} call_id=${callId}`)

      pushEvent({
        call_id: callId,
        type: eventType,
        from,
        content,
        ts: String(msg.ts || new Date().toISOString()),
      })
    }
  }

  ws.onclose = () => {
    wsReady = false
    log(`disconnected — reconnecting in ${reconnectDelay / 1000}s...`)
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      connectWebSocket()
    }, reconnectDelay)
  }

  ws.onerror = (err) => {
    log(`WebSocket error: ${err}`)
  }
}

// Track last message ID per call for reply_to
const lastMessageIds = new Map<string, string>()

// Late response queue — when Claude responds but the server already timed out,
// queue the response and deliver it on the next event for this call.
const queuedResponses = new Map<string, { action: string; text: string; hangup: boolean }>()

function sendWsResponse(callId: string, action: string, text: string, hangup?: boolean) {
  if (!ws || !wsReady) {
    log('WebSocket not connected — cannot respond')
    return false
  }

  const replyTo = lastMessageIds.get(callId)
  if (!replyTo) {
    // No message ID — queue for next event on this call
    log(`Queuing late response for call ${callId}`)
    queuedResponses.set(callId, { action, text, hangup: !!hangup })
    return true
  }

  ws.send(JSON.stringify({
    reply_to: replyTo,
    action: hangup ? 'say' : 'gather',
    text,
    timeoutSec: hangup ? undefined : 5,
    bargeIn: hangup ? undefined : true,
  }))

  lastMessageIds.delete(callId)
  return true
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'phone4ai', version: '2.0.1' },
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
    ].join('\\n'),
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
        const event = await waitForEvent(LISTEN_TIMEOUT_MS)
        if (!event) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ event: null, message: 'No events in 30s. Call phone_listen again to keep waiting.' }) }],
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(event) }],
        }
      }

      case 'phone_respond': {
        const callId = args.call_id as string
        let text = args.text as string
        const hangup = args.hangup as boolean | undefined

        if (text.length > 500) text = text.substring(0, 497) + '...'

        const sent = sendWsResponse(callId, hangup ? 'say' : 'gather', text, !!hangup)
        if (!sent) {
          return {
            content: [{ type: 'text', text: 'Warning: Could not send response — WebSocket not connected.' }],
            isError: true,
          }
        }

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
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PHONE4AI_KEY}` },
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
        sendWsResponse(callId, 'say', 'Goodbye.', true)
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

// ── Start ────────────────────────────────────────────────────────────────────

if (!PHONE4AI_KEY) {
  log('ERROR: PHONE4AI_KEY not set. Get your API key from https://api.phone4.ai/account')
  process.exit(1)
}
if (!PHONE4AI_NUMBER) {
  log('WARNING: PHONE4AI_NUMBER not set — outbound calls disabled')
}

connectWebSocket()

const transport = new StdioServerTransport()
await mcp.connect(transport)
log('MCP server connected to Claude Code')
