# ADR 0007: Unanimous start-now override for forming public matches

Status: Accepted
Date: 2026-03-29

## Context

ADR `0006` kept a fill timer so public matches could keep growing toward larger odd lobbies, but that created dead time when a coordinated group was already present and wanted to begin immediately.

The public queue still benefits from a fill window by default:

- it preserves the ability to grow beyond the minimum `3` players
- it gives late arrivals a chance to join the current public match
- it keeps bot backfill from forcing fast bot matches on humans who would rather wait

At the same time, a group of humans already inside the current forming match should be able to opt out of the rest of the wait explicitly.

## Decision

Public matchmaking keeps the fill timer from ADR `0006`, with one override:

- each human player in the current forming public match may cast a `start now` vote
- bots do not vote and do not block the override
- if every human in that current forming match has voted `start now`, and the reserved player count is already a valid odd public match size, the match starts immediately
- if the reserved count is even, unanimous `start now` votes remain armed but do not launch until the reserved count becomes odd or the normal fill timer path resolves the lobby
- `start now` votes are scoped to the current queue entry and reset when a player leaves the queue, disconnects out of queue, is removed from the forming cohort, or starts a match

## Consequences

- coordinated groups can skip unnecessary idle time without removing the public fill window for everyone else
- the product keeps growing public lobbies by default instead of collapsing into immediate `3`-player starts
- even-sized ready groups still obey the odd-lobby rule, so unanimity does not bypass the plurality-size constraint
- queue UI and websocket payloads must expose start-now readiness so humans can see when unanimity is close
