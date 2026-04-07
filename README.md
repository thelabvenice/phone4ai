# phone4ai

A phone number for your Claude. Receive and make real phone calls from your Claude Code session — with full access to your tools, project, and data mid-call.

## Quick Start

### 1. Get a number

Sign up at [phone4.ai](https://www.phone4.ai) and pay $5/month. You'll get a real US phone number.

### 2. Copy your config

From your [account page](https://api.phone4.ai/account), copy the `.mcp.json` block. It has your API key and number pre-filled.

### 3. Add to your project

Paste into your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "phone4ai": {
      "command": "npx",
      "args": ["phone4ai"],
      "env": {
        "PHONE4AI_KEY": "p4ai_your_key_here",
        "PHONE4AI_NUMBER": "+1your_number"
      }
    }
  }
}
```

### 4. Start listening

Restart Claude Code, then:

```
Listen for incoming phone calls
```

Call your number. Claude answers.

## What can Claude do during a call?

Everything it can do in a normal session:

- **Web search** — "Look up competitors in the AI voice space"
- **File operations** — "Save a log of this call to the project"
- **Database queries** — "Check the latest deploy status"
- **Send messages** — "Text this summary to my Telegram"
- **Code search** — "What does the auth middleware do?"

## MCP Tools

| Tool | Description |
|------|-------------|
| `phone_listen` | Wait for the next call event (blocks up to 30s) |
| `phone_respond` | Reply to the caller (text is spoken aloud) |
| `phone_call` | Make an outbound call |
| `phone_hangup` | End an active call |
| `phone_status` | Check account status |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PHONE4AI_KEY` | Yes | API key from your [account page](https://api.phone4.ai/account) |
| `PHONE4AI_NUMBER` | Yes | Your Phone4.ai number (E.164) |
| `PHONE4AI_API` | No | API endpoint (default: https://api.phone4.ai) |

## How it works

```
Your phone ──call──> Phone4.ai ──WebSocket──> Claude Code
                                  <──reply──
```

No tunnel. No ngrok. No port forwarding. The plugin opens an outbound WebSocket to Phone4.ai — your machine never needs to be publicly reachable. When someone calls your number, the voice is transcribed and pushed to Claude in real time. Claude's response is spoken back to the caller.

## Pricing

- **Phone number:** $5/month ([phone4.ai](https://www.phone4.ai))
- **Claude Code:** Any plan that supports MCP servers

## License

Apache-2.0
