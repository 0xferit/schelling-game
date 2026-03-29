# ADR 0002: Persistent internal token economy

Status: Accepted
Date: 2026-03-23

Supersession note: ADR [0006](0006-generalize-public-match-sizes.md) supersedes this ADR's original `3/5/7` divisibility rationale and `60`-token ante. The rest of this ADR remains canonical.

## Context

The public product needs a simple persistent progression system and leaderboard, but these balances are not intended to be onchain assets or real-money instruments.

The design also needs integer-only per-round settlement even when:

- ties create multiple winning options
- odd match sizes vary between 3, 5, and 7

## Decision

The canonical public economy uses:

- new accounts start at `0` internal tokens
- balances persist across games
- balances may go negative
- tokens are stored in the application database
- tokens are not ERC20 assets and have no financial value
- public leaderboard rank is balance-first among accounts that remain eligible after anti-abuse review

Per round:

- every player still attached to the match antes `2520`
- coherent players split the round pot equally, with any indivisible dust burned

For odd public match sizes up to `21`, any indivisible remainder after equal winner payouts is burned.

## Consequences

- Queue access is not blocked by low or negative balance.
- Current token balance remains the simplest progression signal, but public ranking is explicitly subject to abuse filtering.
- Total token supply is not conserved because some mechanics burn balances.
- The prototype's reset-per-game balance model is now explicitly non-canonical.
