---
name: configure
description: Set up the Phone4.ai voice channel — configure API key and phone number. Use when the user says "set up phone", "configure phone4ai", or "/phone4ai:configure".
---

# Phone4.ai Voice Channel Setup

Configure the voice channel so Claude can receive and make phone calls.

## Step 1: Check for existing config

Check if the user already has a `.mcp.json` in their project root. If it exists and has a `phone4ai` entry, show the current config and ask if they want to update it.

## Step 2: Get credentials

The user needs two things from their Phone4.ai account page (https://api.phone4.ai/account):

1. **API key** (`PHONE4AI_KEY`) — a `p4ai_` prefixed key shown on the account page
2. **Phone number** (`PHONE4AI_NUMBER`) — their provisioned US number in E.164 format (e.g., +14474661303)

If they don't have an account yet, direct them to https://api.phone4.ai/account/login to sign up ($5/month).

## Step 3: Add to .mcp.json

Add or update the `phone4ai` entry in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "phone4ai": {
      "command": "npx",
      "args": ["phone4ai"],
      "env": {
        "PHONE4AI_KEY": "p4ai_...",
        "PHONE4AI_NUMBER": "+1..."
      }
    }
  }
}
```

If `.mcp.json` already has other MCP servers, merge the `phone4ai` entry — don't overwrite existing servers.

## Step 4: Verify

Restart the Claude session so the MCP server connects. Then:

1. Check `/mcp` — phone4ai should show as connected
2. Server logs should show "authenticated — listening on +1..."
3. Run `/listen` and make a test call to the Phone4.ai number
