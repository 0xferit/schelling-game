# Schelling Game Design

Status: canonical game-rules document

This document defines Schelling Game's rules and match logic. It is authoritative for gameplay behavior.

Authentication, transport, persistence, leaderboard implementation, and UI are out of scope.

## 1. Game Summary

Schelling Game is a multiplayer coordination game. In each round, every player independently picks the option they expect the most other players to pick. Answers are hidden during commit, opened during reveal, and settled by exact-match plurality.

The game distinguishes between two outcomes:

- economic outcome: who wins the round pot
- coordination outcome: whether a winning choice showed actual shared convergence

The intended skill is not specialist knowledge. It is identifying focal points that other ordinary players will also identify.

## 2. Core Concepts

- Match: one complete game with exactly `3`, `5`, or `7` players.
- Round: one `commit -> reveal -> results` cycle built around one question.
- Question: a prompt with a fixed ordered list of discrete answer options.
- Attached player: a player still counted for round accounting. A forfeited player remains attached until the match ends.
- Valid reveal: a reveal from an attached, non-forfeited player who committed in time, revealed in time, and passed commitment verification.
- `topCount`: the largest number of valid reveals on any single option in a round.

## 3. Match Format

- Match size is exactly `3`, `5`, or `7` players.
- Every match lasts `10` rounds unless it ends early under the rule in section 4.
- Every round uses one `select` question from the canonical public question pool.
- Questions are used without replacement inside a match.
- Phase timings are fixed (source of truth: `src/domain/constants.ts`):
  - commit: `60` seconds
  - reveal: `15` seconds
  - results: `20` seconds

## 4. Round Flow

For each round:

1. A select question is presented.
2. Every attached player is scheduled to ante `60`.
3. During commit, each player chooses one option and submits a commitment hash.
4. The round enters reveal when either all non-forfeited players have committed or the commit timer expires.
5. During reveal, each committed non-forfeited player reveals the exact option index and salt used in the commitment.
6. The round finalizes when either all committed non-forfeited players have revealed or the reveal timer expires.
7. The round is settled and the results phase runs for `20` seconds.
8. The next round starts unless the match has ended.

The match ends after `10` rounds, or earlier only if no non-forfeited player remains able to reveal in future rounds.

## 5. Disconnects, Reconnects, and Forfeits

This section applies only to an already-started match.

If a player disconnects during an active match:

- a reconnect grace window of `15` seconds begins
- the match timers continue to run
- the match does not pause or rewind for the disconnected player

If the player reconnects within `15` seconds:

- they resume the same match
- they may act only if the relevant phase is still open for them
- if the phase already closed, they simply miss that action and are settled under the normal round rules

If the player does not reconnect within `15` seconds, they forfeit:

- they remain attached to the match for accounting purposes
- they may no longer commit or reveal
- the current round settles based on whatever actions they did or did not complete before forfeiture
- in each later non-voided round they lose the ante and cannot be a winner
- in a later voided round their ante is refunded along with everyone else's

## 6. Questions and Commit-Reveal

The game uses `select` questions only.

Question rules:

- each option has a stable zero-based index
- clients must preserve the provided option order
- scoring uses exact option identity, not numeric distance or proximity
- option order must not be randomized within a round

The commitment preimage is:

`"${optionIndex}:${salt}"`

where:

- `optionIndex` is the exact zero-based index of the chosen option
- `salt` is a player-generated random hex string

The commitment hash is the SHA-256 hex digest of that preimage.

Salt rules:

- `salt` must be a hex string
- `salt` must be at least `32` hex characters long
- shorter salts are invalid

Reveal verification succeeds only if the recomputed hash exactly matches the committed hash.

## 7. Settlement and Coordination Credit

### Round Ante

Each round uses a fixed ante:

`ante = 60`

Every attached player contributes the ante for accounting purposes.

### Valid Reveals

Only valid reveals participate in plurality counting.

A reveal is valid only if the player:

- was attached and not already forfeited before the round began
- committed during commit phase
- revealed during reveal phase
- passed commitment verification

### Void Rule

A round is voided only if there are zero valid reveals.

In a voided round:

- all round antes are refunded
- no player receives coordination credit
- no round winner is recorded

### Exact-Match Plurality Winners

Definitions:

- `count(optionIndex)`: number of valid reveals for that exact option
- `topCount`: maximum value of `count(optionIndex)` across revealed options
- `winningOptions`: every option index whose count equals `topCount`
- `winnerCount`: number of players whose valid reveal is on a winning option
- `roundPlayerCount`: number of attached players in the round
- `pot = roundPlayerCount * 60`

A player wins the round if and only if:

- they produced a valid reveal, and
- their revealed option index is in `winningOptions`

All attached players who do not win lose the round.

Consequences:

- if exactly one player reveals validly, that player wins the whole pot
- if multiple options tie for top count, all players on those tied top options win
- missing commit or missing reveal is equivalent to losing the round

### Pot and Payout

In a non-voided round:

- every attached player contributes `60` to the pot
- winners split the entire pot equally
- losers receive no round payout

Per-player net round delta:

- winner: `(pot / winnerCount) - 60`
- loser: `-60`

Because the match size is restricted to `3`, `5`, or `7` and the ante is `60`, the split remains integer-valued in every allowed outcome.

### Coordination Credit

Economic settlement and coordination credit are intentionally separate.

A player earns coordination credit if and only if:

- the round is non-voided
- the player won the round
- `topCount >= 2`

Consequences:

- rounds with `topCount = 1` can still settle economically, but they do not count as successful coordination
- this includes all-distinct rounds and single-valid-revealer rounds
- unanimous rounds do award coordination credit
- tied pluralities such as `2-2-1` award coordination credit to all winners on the tied top options

## 8. Question Design Policy

Questions must test coordination behavior, not specialist knowledge.

Canonical prompts may rely on:

- subjective taste
- social convention
- everyday judgment
- simple common knowledge that does not require lookup
- broadly shared intuitions about categories, priorities, or symbolism

Canonical prompts may not rely on:

- trivia
- specialist or academic knowledge
- exact dates
- exact percentages
- expert estimation

Because settlement uses exact-match plurality, prompts should present discrete focal alternatives rather than numeric scales.

The canonical pool may include a small calibration subset of intentionally obvious prompts. Calibration prompts are optional, must be answerable without lookup, and a `10`-round match may contain at most one such prompt.

## 9. Worked Examples

### Zero Valid Reveals

In a `3`-player round, if nobody produces a valid reveal:

- the round is voided
- the pot is effectively refunded rather than paid out
- every player's net delta is `0`
- nobody earns coordination credit

### Single Valid Revealer

In a `3`-player round, if exactly one player reveals validly:

- `pot = 3 * 60 = 180`
- `winnerCount = 1`
- the single revealer gets `180`
- the winner's net delta is `+120`
- each other player gets `-60`
- nobody earns coordination credit because `topCount = 1`

### `2-1` Split

In a `3`-player round where two players pick the same winning option and one player picks another:

- `pot = 180`
- `winnerCount = 2`
- each winner gets `90`
- each winner's net delta is `+30`
- the loser gets `-60`
- both winners earn coordination credit because `topCount = 2`

### `2-2-1` Split

In a `5`-player round where two options tie for first with two valid reveals each:

- `pot = 5 * 60 = 300`
- `winnerCount = 4`
- each winner gets `75`
- each winner's net delta is `+15`
- the minority player gets `-60`
- all four winners earn coordination credit because `topCount = 2`

### Unanimous Convergence

In a `5`-player round where all five players reveal the same option:

- `pot = 300`
- `winnerCount = 5`
- each player gets `60`
- every player's net delta is `0`
- every player earns coordination credit because `topCount = 5`

### Forfeited Player in a Later Round

In a `3`-player match, suppose one player has already forfeited before a later round begins and the two remaining active players reveal the same option:

- the forfeited player is still attached, so `pot = 3 * 60 = 180`
- the two active players are the only winners
- each winner gets `90`
- each winner's net delta is `+30`
- the forfeited player gets `-60`
- both active winners earn coordination credit because `topCount = 2`

## 10. Out of Scope

This document does not define:

- how players authenticate or identify themselves
- how matches are formed, queued, or rematched
- REST endpoints, WebSocket messages, or transport rules
- database schema, persistence strategy, or exports
- leaderboard implementation, moderation workflow, or ranking policy
- UI flows, screens, or copy
- implementation gaps, backlog items, or migration steps
