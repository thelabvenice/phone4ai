# phone4ai

A phone number for your Claude. Receive and make real phone calls from your Claude Code session — with full access to your tools, project, and data mid-call.

## Quick Start

### 1. Get a number

Sign up at [phone4.ai](https://www.phone4.ai) and pay $5/month. You'll get a real US phone number.

### 2. Set up ngrok

You need a tunnel so calls can reach your local machine. Get an [ngrok account](https://dashboard.ngrok.com/signup) with a [fixed domain](https://dashboard.ngrok.com/domains) ($8/month).

### 3. Configure

Create `~/.claude/channels/phone4ai/.env`:

```bash
mkdir -p ~/.claude/channels/phone4ai
cp .env.example ~/.claude/channels/phone4ai/.env
# Edit with your credentials
```

### 4. Connect your number

From your [account page](https://api.phone4.ai/account), copy your connect code. Then:

```bash
curl -X POST https://api.phone4.ai/v1/connect \
  -H "Content-Type: application/json" \
  -d '{"code": "YOUR-CONNECT-CODE", "agentWebhook": "https://YOUR-NGROK-DOMAIN"}'
```

### 5. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "phone4ai": {
      "command": "npx",
      "args": ["phone4ai"]
    }
  }
}
```

Or run with the plugin flag:

```bash
claude --plugin-dir /path/to/phone4ai
```

### 6. Start listening

In your Claude Code session:

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

The caller hears Claude's responses spoken aloud via ElevenLabs TTS.

## MCP Tools

| Tool | Description |
|------|-------------|
| `phone_listen` | Wait for the next call event (blocks up to 30s) |
| `phone_respond` | Reply to the caller (text → speech) |
| `phone_call` | Make an outbound call |
| `phone_hangup` | End an active call |
| `phone_status` | Check account status |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PHONE4AI_NUMBER` | Yes | Your Phone4.ai number (E.164) |
| `NGROK_AUTHTOKEN` | Yes | ngrok auth token |
| `NGROK_DOMAIN` | Yes | ngrok fixed domain |
| `ELEVENLABS_API_KEY` | No | ElevenLabs API key (for high-quality TTS) |
| `ELEVENLABS_VOICE_ID` | No | ElevenLabs voice ID |
| `PHONE4AI_API` | No | API endpoint (default: https://api.phone4.ai) |
| `PHONE_WEBHOOK_PORT` | No | Webhook port (default: 7600) |

## Pricing

- **Phone number:** $5/month ([phone4.ai](https://www.phone4.ai))
- **ngrok tunnel:** $8/month for fixed domain ([ngrok.com](https://ngrok.com))
- **ElevenLabs TTS:** Optional, free tier available ([elevenlabs.io](https://elevenlabs.io))
- **Claude Code:** Requires Max or Max Pro subscription

## License

Apache-2.0
