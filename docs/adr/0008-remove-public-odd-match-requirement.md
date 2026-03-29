# ADR 0008: Remove public odd-match requirement

Status: Accepted
Date: 2026-03-29

## Context

The original odd-lobby rule came from an earlier binary-majority framing of the game. The shipped public product has since converged on:

- multi-option `select` questions
- exact-match plurality settlement
- tied top options that already co-win

Under that ruleset, odd player counts do not guarantee a unique winning option, and even player counts do not prevent one. The parity restriction now creates queue friction without delivering a meaningful gameplay invariant.

The practical product failure is straightforward: a coordinated group of `4`, `6`, or `8` humans cannot start together even though the current settlement logic can already handle those lobbies.

## Decision

The public product now allows any match size from `3` to `21`.

Matchmaking rules:

- a forming public match may grow until it reaches `21` players
- when the fill timer expires, the current reserved cohort starts as long as it still has at least `3` players
- if `21` players are reserved before the timer expires, the match starts immediately
- if every human in the current forming match votes `start now`, the match starts immediately regardless of parity

AI backfill rules:

- automatic AI backfill remains limited to queues with `1` or `2` humans
- AI bots are used only to reach the minimum playable size of `3`, not to repair parity in larger groups
- AI-assisted matches remain off the record

This ADR supersedes the odd-lobby rationale in ADR `0001`, the odd-only size rule and even-count trimming behavior in ADR `0006`, and the parity gate in ADR `0007`.

## Consequences

- coordinated groups of any size from `3` to `21` can play together directly
- queue UI and websocket metadata should describe the valid launch sizes as a continuous range
- settlement, persistence, and token accounting do not change
- question design and plurality behavior, not lobby parity, remain the real determinants of tie frequency
