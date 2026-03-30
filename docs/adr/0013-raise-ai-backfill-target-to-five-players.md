# ADR 0013: Raise AI backfill target to five players

Status: Accepted
Date: 2026-03-30

Supersession note: This ADR supersedes ADR [0011](0011-restore-limited-ai-backfill.md)'s three-seat AI backfill target and ADR [0008](0008-remove-public-odd-match-requirement.md)'s matching AI-backfill subsection. The rest of those ADRs remain canonical.

## Context

ADR `0011` restored limited AI backfill so thin public queues could still produce a playable match. That solved queue deadlock, but the resulting `3`-player AI-assisted runs are too sparse to feel like satisfying coordination games.

The product problem is no longer availability alone. Match quality also matters:

- a `3`-seat lobby leaves too little crowd signal for focal-point play
- the current runtime already supports larger AI-assisted cohorts without new settlement work
- AI-assisted matches are still off the record, so expanding the synthetic fill target does not distort balance or leaderboard progression

## Decision

Limited public AI backfill now targets `5` total players instead of `3`:

- automatic AI backfill is enabled only when `AI_BOT_ENABLED` is true
- automatic AI backfill applies to public queues with `1` to `4` humans
- bots are used only to reach a `5`-player public match
- if additional humans arrive before launch, synthetic seats are removed and replaced by humans
- AI-assisted matches remain off the record: balances, streaks, and leaderboard standing do not change

Human-only public matches are still allowed from `3` to `21` players. The `5`-seat target applies only to AI-assisted backfill.

## Consequences

- low-concurrency public matches have more crowd signal and should feel less degenerate than `3`-seat bot-assisted runs
- thin lobbies will use more synthetic seats and slightly more Workers AI budget before launch
- human groups of `5+` still launch without synthetic seats
- canonical rules and tests must describe AI backfill as a five-seat target rather than a three-seat rescue path
