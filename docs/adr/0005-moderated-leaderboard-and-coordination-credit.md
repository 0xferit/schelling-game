# ADR 0005: Moderated leaderboard and coordination credit

Status: Accepted
Date: 2026-03-23

## Context

Two problems remained after the shift to plurality scoring:

- payout winners are not always evidence of successful coordination,
- a raw public-balance leaderboard is trivially farmable with disposable sybil accounts in a public queue.

Examples:

- a `1-1-1` split and a `3-0-0` split can both produce net-zero payout outcomes for all players, but only the latter is real convergence,
- a single valid revealer can correctly win the pot economically, but that outcome is not evidence of group coordination,
- a self-operator with multiple wallets can farm raw balance unless public ranking is filtered for abuse.

## Decision

The canonical public product separates round economics from coordination measurement and makes public ranking explicitly abuse-filtered.

Rules:

- round winners are determined by plurality for payout purposes,
- coordination credit is awarded only when a non-voided round has `topCount >= 2`,
- all-distinct rounds and single-valid-reveal rounds do not award coordination credit or extend streaks,
- tied pluralities still award coordination credit to winning players because the product uses `topCount >= 2` as a bright-line test for observed shared choice, not as a guarantee of unique convergence,
- only accounts with `leaderboard_eligible = true` may appear on the public leaderboard,
- the operator may exclude accounts suspected of self-play, linked-account play, sacrificial-alt farming, queue manipulation, or similar abuse.

## Consequences

- The public stats better reflect actual observed coordination rather than mere payout outcomes.
- Unanimous rounds still count as successful coordination.
- Single-revealer and all-distinct rounds still settle economically, but they do not inflate coordination metrics.
- Some winning rounds therefore increase balance without increasing streak or coherent-round stats, and the client should surface that distinction clearly.
- The public leaderboard is explicitly a moderated product surface, not a purely automatic trustless ranking.
- Sybil resistance remains out of scope for v1; the design documents this limitation instead of pretending the public leaderboard is identity-hard.
