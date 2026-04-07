---
name: configure
description: Set up the Phone4.ai voice channel — configure phone number, ngrok tunnel, and ElevenLabs TTS. Use when the user says "set up phone", "configure phone4ai", or "/phone4ai:configure".
---

# Phone4.ai Voice Channel Setup

Configure the voice channel so Claude can receive and make phone calls.

## Step 1: Check state directory

Check if `~/.claude/channels/phone4ai/.env` exists. If it does, read current values and show what's configured vs missing. If not, create the directory and an empty `.env` file:

```bash
mkdir -p ~/.claude/channels/phone4ai
touch ~/.claude/channels/phone4ai/.env
chmod 600 ~/.claude/channels/phone4ai/.env
```

## Step 2: Phone4.ai number

Ask the user for their Phone4.ai number (E.164 format, e.g., +14474661303).

They can get this from their account at https://api.phone4.ai/account. If they don't have an account yet, direct them there to sign up ($5/month).

Save as `PHONE4AI_NUMBER` in the `.env` file.

## Step 3: ngrok tunnel

The plugin uses ngrok to expose the local webhook server to the internet. The user needs:

1. An ngrok account (https://dashboard.ngrok.com/signup)
2. An auth token (https://dashboard.ngrok.com/get-started/your-authtoken)
3. A fixed domain — free tier gets random URLs. For a stable phone webhook, they need a paid plan ($8/month) with a fixed domain (https://dashboard.ngrok.com/domains)

Ask for:
- `NGROK_AUTHTOKEN` — their ngrok auth token
- `NGROK_DOMAIN` — their fixed domain (e.g., `my-claude-phone.ngrok-free.app`)

Save both to the `.env` file.

## Step 4: ElevenLabs TTS (optional)

ElevenLabs provides high-quality voice synthesis. Without it, Twilio's built-in TTS is used (lower quality but functional).

If the user wants ElevenLabs:
- `ELEVENLABS_API_KEY` — from https://elevenlabs.io/app/settings/api-keys
- `ELEVENLABS_VOICE_ID` — the voice to use (browse at https://elevenlabs.io/app/voice-library)

Check macOS Keychain first: `security find-generic-password -s "elevenlabs-api-key" -w 2>/dev/null`

Save to `.env` file if provided.

## Step 5: Connect webhook

The user needs to connect their ngrok domain to their Phone4.ai number. Two options:

**Option A: Connect code (recommended)**
1. Go to https://api.phone4.ai/account
2. Click "Generate Connect Code"
3. Run:
```bash
curl -X POST https://api.phone4.ai/v1/connect \
  -H "Content-Type: application/json" \
  -d '{"code": "THE_CONNECT_CODE", "agentWebhook": "https://NGROK_DOMAIN"}'
```

**Option B: Already connected**
If the webhook URL is already set (from a previous setup), just verify:
```bash
curl "https://api.phone4.ai/v1/status?humanPhone=PHONE4AI_NUMBER"
```

## Step 6: Verify

Restart the Claude session so the MCP server picks up the new config. Then:

1. Check `/mcp` — phone4ai should show as connected
2. Check server logs for "ngrok tunnel up: https://..." and "ready for calls"
3. Run `/listen` and make a test call to the Phone4.ai number
