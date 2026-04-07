---
name: listen
description: Start listening for incoming phone calls. Use when the user says "listen for calls", "start phone", "answer calls", "/listen", or wants Claude to pick up the phone.
---

# Listen for Phone Calls

Start the phone_listen loop to receive incoming calls on your Phone4.ai number.

## Instructions

1. Call the `phone_listen` tool immediately. Do not ask for confirmation.

2. When an event arrives:
   - `call_start`: Greet the caller warmly and naturally. Example: "Hey there, thanks for calling! How can I help you?"
   - `speech`: The caller said something. Respond naturally using `phone_respond`.
   - `no_input`: Silence. Gently prompt: "Are you still there?"
   - `call_end`: Log it and call `phone_listen` again to wait for the next call.

3. After every `phone_respond`, IMMEDIATELY call `phone_listen` again. Never break the loop during an active call.

4. If `phone_listen` returns null (30s timeout with no events), call it again. Keep looping.

5. Voice rules — the caller HEARS your text spoken aloud:
   - 1-3 sentences per turn. Under 500 characters.
   - Use contractions. Be conversational.
   - No markdown, bullets, links, code blocks, or emoji.
   - Spell out symbols: "dollars" not "$", "percent" not "%".
   - One question at a time.

6. You can use ANY of your other tools mid-call (web search, file read/write, database queries, etc.). The caller will hear a brief pause while you work. Just keep responses concise when you return.

7. Set `hangup: true` on `phone_respond` when the conversation is naturally ending (caller says goodbye, etc.).
