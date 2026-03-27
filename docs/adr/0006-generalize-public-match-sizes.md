# ADR 0006: Generalize public match sizes to odd counts up to 21

Status: Accepted
Date: 2026-03-27

## Context

The `3/5/7` public-match restriction kept settlement examples neat, but it also created unnecessary queue friction:

- marketing copy had to warn visitors that only a few exact lobby sizes could fire
- landing-page trust was weaker because a user could not infer whether a partial queue was viable
- real queue health was worse than it needed to be because a live crowd of `9`, `11`, or `13` still had to be shaved down into the old bracket set

Plurality scoring still benefits from odd committees, but the product does not need the narrower `3/5/7` subset.

## Decision

The public product now allows any odd match size from `3` to `21`.

Matchmaking rules:

- a forming public match may grow until it reaches `21` players
- if a fill timer expires on an even count, the newest reserved player returns to the queue so the started match remains odd
- if `21` players are reserved before the timer expires, the match starts immediately

Settlement rules:

- round ante remains `60`
- payout per winner remains `floor(pot / winnerCount)`
- if the pot does not divide evenly, the remainder is not distributed

This ADR supersedes the public-match-size restriction in ADR `0001` and the divisibility rationale in ADR `0002`.

## Consequences

- queue conversion should improve because any sufficiently large odd crowd can launch
- landing-page copy can describe a wider viable public lobby
- integer-only exact pot division is no longer guaranteed in every outcome, so canonical docs must describe floor payout explicitly
