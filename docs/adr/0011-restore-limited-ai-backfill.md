# ADR 0011: Restore limited AI backfill for ten-seed public mode

Status: Accepted
Date: 2026-03-30

Supersession note: This ADR supersedes ADR [0010](0010-ten-seed-ai-normalized-public-mode.md)'s blanket prohibition on AI-assisted public matches. The rest of ADR `0010` remains canonical.

## Context

ADR `0010` correctly narrowed the public product to one fixed ten-prompt catalog with authoritative Workers AI normalization for `open_text` settlement. In the same change, public AI-assisted matches were disabled entirely.

That removal regressed queue availability. A solo or duo human lobby can no longer promote itself to a playable public match, even though:

- the runtime already supports synthetic players end to end
- AI-assisted matches are already neutralized economically
- the public UI already explains that bot-assisted runs are off the record

The intended product behavior from ADR `0008` was narrower than a blanket ban: AI backfill should remain limited to raising `1`- or `2`-human public queues to the minimum playable size of `3`.

## Decision

The ten-seed public catalog keeps authoritative Workers AI normalization for `open_text` prompts, and also restores limited AI backfill:

- automatic AI backfill is enabled only when `AI_BOT_ENABLED` is true
- automatic AI backfill is limited to public queues with `1` or `2` humans
- bots are used only to reach the minimum playable size of `3`
- if additional humans arrive before launch, synthetic seats are removed and replaced by humans
- AI-assisted matches remain off the record: balances, streaks, and leaderboard standing do not change

## Consequences

- low-concurrency public sessions regain a playable path instead of stalling below `3`
- the fill-timer and unanimous `start now` flow remain intact because backfilled lobbies still form through the normal queue path
- human-only crowds of `3+` players continue to launch without synthetic seats
- the public rules and config docs must describe AI backfill as limited availability support, not a disabled legacy path
