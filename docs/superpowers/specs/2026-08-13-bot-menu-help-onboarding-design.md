# Bot menu, /help, and richer onboarding intro

## Problem

The bot has no Telegram menu button (☰) at all — `setMyCommands` is never
called, so the client has nothing to show there. There's no `/help`.
Onboarding's only framing is "Quick 8-question setup... free text won't
parse" — no explanation of what happens after setup (proactive pushes every
~3h, swipe to build a shortlist, prefs are editable later).

## Design

### 1. Menu button

New exported `BOT_COMMANDS: { command: string; description: string }[]` in
bot.ts — pure data, listing `start`, `next`, `shortlist`, `settings`,
`help` with one-line descriptions. `index.ts`'s `main()` calls
`await bot.telegram.setMyCommands(BOT_COMMANDS)` once at startup, before the
first poll. Kept out of `createBot` (which stays synchronous) so it doesn't
need an awaited side effect wired through the already-large constructor —
`BOT_COMMANDS` itself is what's unit tested; the one-line `setMyCommands`
call in `index.ts` isn't covered (that file already has no test coverage,
same as the rest of the process-entrypoint wiring).

### 2. `/help` command

New `bot.command('help', ...)` sending a static message: what the bot does,
how the swipe/shortlist loop works, a one-line description of each command,
and the existing `SAFETY_NOTICE`. Works before onboarding — it's static text
with no DB dependency.

### 3. Richer onboarding intro

`ONBOARDING_INTRO` gains a lead-in explaining the bigger picture (proactive
~3h polling, swipe to shortlist, prefs editable later via `/shortlist` and
`/settings`) before the existing mechanical instruction ("reply with just
the value... free text won't parse"). The mechanical instruction's wording
is unchanged, so existing tests asserting on it keep passing — this is a
same-message content change, not a new message or a new question.

## Testing

- `BOT_COMMANDS`: exact command list and non-empty descriptions.
- `/help`: handler-level test asserting the reply mentions swiping, the
  poll cadence, and the safety notice.
- Onboarding intro: existing test assertions (`/never transfer money/`,
  `/free text won't parse/`) continue to pass; new assertion that the intro
  also explains what happens after setup.

## Out of scope

- Guarding `/start` against silently re-running onboarding on an
  already-configured chat (explicitly deferred by the user this round).
