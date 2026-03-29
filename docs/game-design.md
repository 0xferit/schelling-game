# The Schelling Game Design

Status: canonical game-rules document

This document defines the rules and match logic for The Schelling Game. It is authoritative for gameplay behavior.

Authentication, transport, persistence, leaderboard implementation, and UI are out of scope.

## 1. Game Summary

The Schelling Game is a multiplayer coordination game played as matches. In each game within a match, every player independently submits the answer they expect the most other players to submit. Answers are hidden during commit, opened during reveal, and settled by exact-match plurality for `select` prompts or by normalized bucket plurality for `open_text` prompts.

Each game distinguishes between two outcomes:

- economic outcome: who wins the game pot
- coordination outcome: whether a winning choice showed actual shared convergence

The intended skill is not specialist knowledge. It is identifying focal points that other ordinary players will also identify.

## 2. Core Concepts

- Match: one complete session with any number of players from `3` to `21`.
- Game: one `commit -> reveal -> results` cycle built around one Schelling prompt.
- Schelling prompt: a fixed prompt designed to elicit focal-point coordination. A prompt is either:
  - `select`: an ordered list of discrete answer options
  - `open_text`: a single short free-text answer field with deterministic transport normalization and post-reveal bucketing
- Attached player: a player still counted for game accounting. A forfeited player is attached only for the game in which they forfeit; they are detached for all subsequent games.
- Valid reveal: a reveal from an attached, non-forfeited player who committed in time, revealed in time, and passed commitment verification.
- `topCount`: the largest number of valid reveals in any winning option or winning answer bucket in a game.

## 3. Match Format

- Match size is any number from `3` to `21`.
- Every match lasts `10` games unless it ends early under the rule in section 4.
- Every match draws from the canonical public prompt pool of `100` literature-rooted prompt adaptations:
  - `80` `select` prompts
  - `20` `open_text` prompts
- Public selection is root-balanced:
  - prompts are used without replacement inside a match
  - a match contains at least `8` distinct prompt families
  - `open_text` prompts are capped at `2` per match
  - the same semantic family may not appear in both `select` and `open_text` form in one match
  - contextualized roots such as `city_in_england`, `nyc_meeting_place`, and `nyc_meeting_time` appear at most once per match
  - a `10`-game match may contain at most one calibration prompt
- `open_text` prompts are available only when Workers AI normalization is enabled and the match is not AI-assisted. Otherwise selection is `select`-only.
- Prompts are used without replacement inside a match.
- Phase timings are fixed (source of truth: `src/domain/constants.ts`):
  - commit: `60` seconds
  - reveal: `15` seconds
  - results: `7` seconds

## 4. Game Flow

For each game:

1. A Schelling prompt is presented.
2. Every attached player is scheduled to ante `2520`.
3. During commit, each player chooses one answer and submits a commitment hash.
4. The game enters reveal when either all non-forfeited players have committed or the commit timer expires.
5. During reveal, each committed non-forfeited player reveals:
   - for `select`: the exact option index and salt used in the commitment
   - for `open_text`: the raw `answerText` and salt used in the commitment
6. The game finalizes when either all committed non-forfeited players have revealed or the reveal timer expires.
7. The game is settled and the results phase runs for `7` seconds.
8. The next game starts unless the match has ended.

The match ends after `10` games, or earlier only if no non-forfeited player remains able to reveal in future games.

## 5. Disconnects, Reconnects, and Forfeits

This section applies only to an already-started match.

If a player disconnects during an active match:

- a reconnect grace window of `15` seconds begins
- the match timers continue to run
- the match does not pause or rewind for the disconnected player

If the player reconnects within `15` seconds:

- they resume the same match
- they may act only if the relevant phase is still open for them
- if the phase already closed, they simply miss that action and are settled under the normal game rules

If the player does not reconnect within `15` seconds, they forfeit:

- they are attached for the current game: the game settles normally with them included in the pot
- they may no longer commit or reveal
- all future-game antes are charged as a one-time penalty when the forfeit game settles (burned: not redistributed to other players)
- from the next game onward the player is detached: pot and results are calculated as if the match shrunk

A player may also choose to forfeit manually from the client during an active match. A manual forfeit is treated exactly like a grace-window expiry at the moment it is triggered.

## 6. Prompts and Commit-Reveal

Prompt rules:

- `select` prompts:
  - each option has a stable zero-based index
  - clients must preserve the provided option order
  - scoring uses exact option identity, not numeric distance or proximity
  - option order must not be randomized within a game
- `open_text` prompts:
  - clients must submit one short single-line answer
  - clients must preserve the raw answer for reveal
  - settlement does not use embedding similarity or free-form semantic scoring; it uses deterministic transport normalization plus conservative bucket assignment

The `select` commitment preimage is:

`"${optionIndex}:${salt}"`

where:

- `optionIndex` is the exact zero-based index of the chosen option
- `salt` is a player-generated random hex string

The `open_text` commitment preimage is:

`"${normalizeRevealText(answerText)}:${salt}"`

`normalizeRevealText(answerText)` applies:

- Unicode `NFKC`
- edge trimming
- internal whitespace collapse
- lowercasing
- curly-quote / apostrophe normalization
- terminal punctuation stripping

Reveal verification succeeds only if the recomputed hash exactly matches the committed hash after the appropriate preimage rule is applied.

The commitment hash is the SHA-256 hex digest of that preimage.

Salt rules:

- `salt` must be a hex string
- `salt` must be between `32` and `128` hex characters long
- shorter salts are invalid

## 7. Settlement and Coordination Credit

### Game Ante

Each game uses a fixed ante:

`ante = 2520`

Every attached player contributes the ante for accounting purposes.

### Valid Reveals

Only valid reveals participate in plurality counting.

A reveal is valid only if the player:

- was attached and not already forfeited before the game began
- committed during commit phase
- revealed during reveal phase
- passed commitment verification

For `open_text`, a valid reveal must also pass answer-shape validation:

- single line only
- non-empty after deterministic transport normalization
- within the prompt-specific maximum length

### Void Rule

A game is voided only if there are zero valid reveals.

In a voided game:

- all game antes are refunded
- no player receives coordination credit
- no game winner is recorded

### Exact-Match Plurality Winners

Definitions:

- for `select`, `count(optionIndex)`: number of valid reveals for that exact option
- for `open_text`, `count(bucketKey)`: number of valid reveals assigned to the same canonical answer bucket
- `topCount`: maximum count across revealed options or answer buckets
- `winningOptions`: every winning option index for a `select` prompt
- `winningBuckets`: every winning bucket key for an `open_text` prompt
- `winnerCount`: number of players whose valid reveal is on a winning option
- `gamePlayerCount`: number of attached players in the game
- `pot = gamePlayerCount * 2520`

For `select` prompts, the bucket key is the exact option identity.

For `open_text` prompts, settlement first runs one normalization pass over the deduplicated valid revealed answers:

- primary mode: Workers AI returns a strict JSON verdict assigning each normalized input string to one canonical bucket
- merge policy: only clearly identical referents or spelling/casing/punctuation variants may be merged
- fallback mode: if the AI call fails, times out, or returns invalid schema, the game falls back to exact-match plurality on deterministically normalized text
- normalization verdicts are persisted so settled outcomes remain replayable and auditable

A player wins the game if and only if:

- they produced a valid reveal, and
- their reveal landed in a winning option or winning bucket

All attached players who do not win lose the game.

Consequences:

- if exactly one player reveals validly, that player wins the whole pot
- if multiple options tie for top count, all players on those tied top options win
- missing commit or missing reveal is equivalent to losing the game

### Pot and Payout

In a non-voided game:

- every attached player contributes `2520` to the pot
- winners receive equal integer payouts computed as `floor(pot / winnerCount)`
- losers receive no game payout
- `dustBurned = pot % winnerCount`
- if the pot does not divide evenly, the remainder is burned and not distributed

Per-player net game delta:

- winner: `floor(pot / winnerCount) - 2520`
- loser: `-2520`

### Coordination Credit

Economic settlement and coordination credit are intentionally separate.

A player earns coordination credit if and only if:

- the game is non-voided
- the player won the game
- `topCount >= 2`

Consequences:

- games with `topCount = 1` can still settle economically, but they do not count as successful coordination
- this includes all-distinct games and single-valid-revealer games
- unanimous games do award coordination credit
- tied pluralities such as `2-2-1` award coordination credit to all winners on the tied top options

## 8. Prompt Design Policy

Prompts must test coordination behavior, not specialist knowledge.

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

Because settlement uses exact-match plurality or conservative bucket plurality, prompts should present salient coordination targets rather than requiring interpretation or specialist lookup.

The canonical pool is literature-rooted: it adapts published focal-point prompt families rather than treating the pool as an unconstrained trivia or survey set.

Prompt design rules:

- one plausible focal-answer family should map to one option or one canonical bucket
- prompts must stay on one abstraction level
- region-specific prompts must be explicitly anchored in the text
- `open_text` prompts are a minority subset used to cover canonical free-response focal-point families without forcing artificial option lists

The canonical pool may include a small calibration subset of intentionally obvious prompts. Calibration prompts are optional, must be answerable without lookup, and a `10`-game match may contain at most one such prompt.

## 9. Worked Examples

### Zero Valid Reveals

In a `3`-player game, if nobody produces a valid reveal:

- the game is voided
- the pot is effectively refunded rather than paid out
- every player's net delta is `0`
- nobody earns coordination credit

### Single Valid Revealer

In a `3`-player game, if exactly one player reveals validly:

- `pot = 3 * 2520 = 7560`
- `winnerCount = 1`
- the single revealer gets `7560`
- the winner's net delta is `+5040`
- each other player gets `-2520`
- nobody earns coordination credit because `topCount = 1`

### `2-1` Split

In a `3`-player game where two players pick the same winning option and one player picks another:

- `pot = 7560`
- `winnerCount = 2`
- each winner gets `3780`
- each winner's net delta is `+1260`
- the loser gets `-2520`
- both winners earn coordination credit because `topCount = 2`

### `2-2-1` Split

In a `5`-player game where two options tie for first with two valid reveals each:

- `pot = 5 * 2520 = 12600`
- `winnerCount = 4`
- each winner gets `3150`
- each winner's net delta is `+630`
- the minority player gets `-2520`
- all four winners earn coordination credit because `topCount = 2`

### Unanimous Convergence

In a `5`-player game where all five players reveal the same option:

- `pot = 12600`
- `winnerCount = 5`
- each player gets `2520`
- every player's net delta is `0`
- every player earns coordination credit because `topCount = 5`

### Burned Dust

In a `13`-player game where `11` players share the winning option:

- `pot = 13 * 2520 = 32760`
- `winnerCount = 11`
- each winner gets `floor(32760 / 11) = 2978`
- `dustBurned = 32760 % 11 = 2`
- each winner's net delta is `+458`
- each losing player gets `-2520`

### Forfeited Player in a Later Game

In a `3`-player match, one player forfeited in game 2. In game 3 the two remaining active players reveal the same option:

- the forfeited player is detached, so `gamePlayerCount = 2` and `pot = 2 * 2520 = 5040`
- the two active players each pay `2520`; both win
- each winner gets `2520`
- each winner's net delta is `0`
- the forfeited player is not part of this game at all
- both active players earn coordination credit because `topCount = 2`

## 10. Out of Scope

This document does not define:

- how players authenticate or identify themselves
- how matches are formed, queued, or rematched
- REST endpoints, WebSocket messages, or transport rules
- database schema, persistence strategy, or exports
- leaderboard implementation, moderation workflow, or ranking policy
- UI flows, screens, or copy
- implementation gaps, backlog items, or migration steps
