# Schelling Game Canonical Public Specification

Status: canonical intended-product specification

This document is authoritative for the intended public version of Schelling Game. When the current Node server, Cloudflare Worker, browser client, or prototype tests differ from this document, this document wins.

## 1. Product Summary

Schelling Game is a public multiplayer coordination game. Authenticated players enter a shared matchmaking queue, are grouped into short matches, and independently commit to one discrete answer option. The game does not test specialist knowledge. It tests whether players can independently converge on the same focal point.

The canonical public product has these top-level properties:

- Public FIFO matchmaking. No room codes, private rooms, or host role.
- Wallet-backed persistent accounts.
- A globally unique public display name per account.
- Public matches use odd player counts only: 3, 5, or 7.
- One standard public match format of 10 rounds.
- Select questions only. No slider questions in the canonical public mode.
- Exact-match plurality scoring, not mean-and-sigma scoring.
- A fixed round ante of 60 internal tokens.
- Token balances persist across games, may go negative, are stored in the application database, are not ERC20 assets, and have no financial value.
- No in-protocol leak-reporting or anti-pre-revelation side-betting mechanic in v1.
- Auto-requeue by default after a match, with an opt-out toggle.

Threat-model boundary:

- This product is a public offchain coordination game, not a trustless oracle, governance protocol, or consensus mechanism.
- The spec does not claim resistance to externally enforceable bribery or other full P-plus-epsilon-style attacks that assume credible conditional side payments with real economic value.
- Internal token balances are game-state only; if they ever become transferable, redeemable, or economically valuable outside the product, this specification is no longer sufficient.

Sybil-resistance boundary:

- v1 does not claim trustless sybil resistance in public matchmaking or public ranking.
- Multiple wallet accounts controlled by one operator can still distort queue composition, match outcomes, and raw balance accumulation.
- This limitation is accepted in v1 because the product goal is to teach focal-point coordination behavior, not to provide identity-hard competitive ranking.
- Public leaderboard output is therefore a moderated product feature, not a cryptographically strong reputation system.

## 2. Core Entities

### 2.1 Account

- `account_id`: canonical persistent account identifier. This is the authenticated wallet address.
- `display_name`: globally unique public identifier shown in queue, match UI, chat, and leaderboard.
- `display_name` format: 1-20 characters, regex `^[A-Za-z0-9_-]{1,20}$`.
- `token_balance`: signed integer internal balance stored in the database.
- New accounts start with `token_balance = 0`.
- `token_balance` may go negative.
- A player may not change `display_name` while queued, forming a match, or inside an active match.

### 2.2 Session

- An authenticated browser session is established after wallet verification.
- WebSocket access to queueing and gameplay requires that authenticated session.
- The session stores one gameplay preference: `auto_requeue`, default `true` once the player explicitly joins queue.

### 2.3 Match

- `match_id`: server-generated unique identifier for a single public match.
- Match size: exactly 3, 5, or 7 players.
- Round count: fixed at 10.
- Players keep their existing persistent `token_balance` when the match starts.

### 2.4 Question

- The canonical public product uses `select` questions only.
- A question provides a finite ordered list of discrete options.
- Scoring uses exact option identity, not option distance.
- Questions are selected without replacement within a match.

## 3. Identity And Authentication

### 3.1 Canonical auth model

The canonical public product uses wallet sign-in. The v1 assumption is an Ethereum-compatible wallet using a signed challenge flow.

The canonical auth flow is:

1. Client requests a sign-in challenge for a wallet address.
2. Server returns a short-lived nonce-based message to sign.
3. Client signs the message in the wallet.
4. Client submits the signature for verification.
5. Server verifies the signature, binds the wallet address to `account_id`, creates or loads the account, and establishes an authenticated session.

### 3.2 Required auth endpoints

#### `POST /api/auth/challenge`

Request body:

```json
{
  "walletAddress": "0xabc123..."
}
```

Response body:

```json
{
  "challengeId": "ch_123",
  "message": "Sign this message to authenticate...",
  "expiresAt": "2026-03-23T12:00:00.000Z"
}
```

Rules:

- `challengeId` is single-use.
- The challenge must expire after 5 minutes or less.
- The message must contain a nonce bound to the requesting wallet address.

#### `POST /api/auth/verify`

Request body:

```json
{
  "challengeId": "ch_123",
  "walletAddress": "0xabc123...",
  "signature": "0xsigned..."
}
```

Response body:

```json
{
  "accountId": "0xabc123...",
  "displayName": "alice",
  "requiresDisplayName": false,
  "tokenBalance": 0,
  "leaderboardEligible": false
}
```

Rules:

- On success, the server establishes an authenticated same-origin session.
- If the account does not yet have a display name, `requiresDisplayName` is `true`.

#### `GET /api/me`

Response body:

```json
{
  "accountId": "0xabc123...",
  "displayName": "alice",
  "tokenBalance": 120,
  "leaderboardEligible": true,
  "autoRequeue": true,
  "queueStatus": "idle"
}
```

#### `PATCH /api/me/profile`

Request body:

```json
{
  "displayName": "alice"
}
```

Rules:

- Requires an authenticated session.
- Fails with `409` if the display name is already claimed.
- Fails with `409` if the player is queued, forming a match, or in an active match.

## 4. Matchmaking

### 4.1 Queue access

A player may enter the public queue only if:

- they have an authenticated session,
- they have a claimed `display_name`,
- they are not already queued,
- they are not in an active match,
- they are not currently marked forfeited in a match awaiting cleanup.

Low or negative token balance does not block queue entry.

### 4.2 Queue ordering

- The queue is global and FIFO.
- No skill, region, or preference filters apply in v1.
- The queue is ordered by the time `join_queue` is accepted by the server.
- FIFO is the default grouping policy, but it is constrained by the anti-repeat matchmaking rule below.
- Players who disconnect while queued are removed from the queue immediately.

### 4.3 Visible waiting room

The canonical public queue has a visible waiting room. Queued players can discover each other before a match starts.

The server must expose:

- total queued player count,
- the ordered list of queued `display_name` values,
- whether a forming match currently exists,
- the visible roster of the forming match,
- the forming-match fill deadline when applicable.

Queue view rules:

- Wallet addresses are never shown in the waiting room.
- Only `display_name` values are shown publicly.
- Players already inside active matches are not shown in the queue.

### 4.4 Forming matches

The queue supports one forming match at a time. Match formation works as follows:

1. When fewer than 3 players are queued, the queue is only waiting.
2. When the third queued player becomes available, the first 3 queued players are reserved into a forming match and a 20-second fill timer starts.
3. While the fill timer is active, additional queued players are pulled into the same forming match in FIFO order until either:
   - the match reaches 7 players, or
   - the fill timer expires.
4. If the forming match reaches 7 players before the timer expires, it starts immediately.
5. If the timer expires, the match starts with the largest odd reserved size available:
   - 7 if 7 are reserved,
   - 5 if 5 or 6 are reserved,
   - 3 if 3 or 4 are reserved.
6. When an even reserved group is reduced to the largest lower odd size at fill expiry, the most recently reserved extra player or players are returned to the front of the waiting queue in their existing relative order.
7. If a reserved player leaves queue or disconnects before start and the reserved group drops below 3 players, the fill timer is canceled and all remaining reserved players return to the front of the waiting queue in their existing relative order.
8. Players beyond the currently forming match remain queued for the next match.

Anti-repeat matchmaking rule:

- When the queue provides an alternative valid grouping, the server should avoid placing a player into a match with anyone who appeared in that player's immediately previous completed match.
- This is a mitigation against repeated small-group collusion, not a guarantee against collusion in a single match.
- FIFO remains the default rule. If enforcing anti-repeat would prevent a 3-player match from forming by the current fill deadline, the server may relax anti-repeat and start the best available FIFO-compatible match.

### 4.5 Auto-start and auto-requeue

- There is no host role.
- There is no `start_game` message in the canonical product.
- Matches start automatically when the fill rules above resolve.

After `game_over`:

- every non-forfeited player is automatically requeued if `auto_requeue = true`,
- the summary screen remains visible until the next match begins or the player opts out,
- a player may send `leave_queue` during the summary screen or while queued to disable `auto_requeue` for the current session and leave the queue immediately.

`join_queue` semantics:

- places the player into the public queue,
- sets `auto_requeue = true` for the current authenticated session.

`leave_queue` semantics:

- removes the player from the public queue if queued,
- removes the player from a forming match if not yet started,
- sets `auto_requeue = false` for the current authenticated session.

### 4.6 Fixed match format

All public matches use:

- exactly 10 rounds,
- the canonical public question pool,
- no per-match customization.

## 5. Match Lifecycle

### 5.1 Phase timings

Each round has three phases:

- Commit: 30 seconds
- Reveal: 15 seconds
- Results: 12 seconds

### 5.2 Round flow

For each round:

1. Server broadcasts `round_start`.
2. Every player still attached to the match is scheduled to ante 60 tokens for the round.
3. During commit phase, players privately choose an option and submit a commitment hash.
4. The round advances to reveal phase when either:
   - all non-forfeited players have committed, or
   - the commit timer expires.
5. During reveal phase, committed players reveal their exact option index and salt.
6. The round finalizes when either:
   - all committed non-forfeited players have revealed, or
   - the reveal timer expires.
7. Server settles the round pot, updates balances, and broadcasts `round_result`.
8. After the 12-second results phase, the next round starts, unless the match has ended.

### 5.3 Early match termination

The match ends early only if no non-forfeited players remain able to reveal in future rounds. If at least one non-forfeited player remains, the match continues.

### 5.4 Chat and information leakage

- Match chat is allowed only during commit phase.
- Queue chat is out of scope for v1.
- v1 does not attempt to adjudicate or economically settle leaks inside the match protocol.
- Leak handling in v1 is limited to ordinary product moderation, anti-abuse review, and matchmaking controls.

## 6. Disconnects, Reconnects, And Forfeits

### 6.1 Queued or forming players

- Disconnect while queued: remove the player from queue immediately.
- Disconnect while reserved in a forming match that has not started: treat it the same as leaving queue immediately.

### 6.2 Active match reconnect grace

Disconnect during an active match triggers a reconnect grace window:

- grace duration: 15 seconds,
- all players are notified via `player_disconnected`.

If the player reconnects within 15 seconds:

- the player resumes the same match,
- the commit and reveal timers continue to run for all other players while they are absent,
- the returning player may act only if the relevant phase is still open for them,
- all players receive `player_reconnected`.

If the relevant phase ends before the player returns:

- they simply miss that action,
- they are treated under the normal round-loss rules for that round,
- the match does not pause or rewind on their behalf.

If the player does not reconnect within 15 seconds:

- the player is marked forfeited,
- they remain attached to the match for accounting purposes,
- they automatically lose ordinary subsequent rounds unless those rounds are voided,
- they may no longer commit or reveal,
- all players receive `player_forfeited`.

### 6.3 Forfeit consequences

For a forfeited player:

- the current round settles normally based on whatever actions they did or did not complete before forfeiture,
- in each later non-voided round they lose the round ante and cannot be a winner,
- in a later voided round their ante is refunded along with everyone else's,
- they are not auto-requeued,
- they still appear in the finished match summary with their final balance.

## 7. Questions And Commit-Reveal

### 7.1 Select-only public mode

The canonical public product uses `select` questions only.

Question rules:

- each option has a stable zero-based index,
- clients must render the provided option order exactly,
- the server and client refer to the chosen answer by exact option index,
- option order must not be randomized client-side or server-side within a round.

Because scoring is exact-match plurality, option order is not interpreted as a numeric distance metric.

### 7.2 Commit hash

The commitment preimage is:

`"${optionIndex}:${salt}"`

where:

- `optionIndex` is the exact zero-based selected option index for the current question,
- `salt` is a player-generated random hex string.

The commitment hash is the SHA-256 hex digest of that preimage.

Salt rules:

- `salt` must be a hex string,
- `salt` must be at least 32 hex characters long, providing at least 128 bits of entropy,
- shorter salts are invalid and must be rejected by the server.

Reveal verification succeeds only if the recomputed hash exactly matches the committed hash.

## 8. Scoring, Void Rules, And Settlement

### 8.1 Round ante

Each round uses a fixed ante:

`ante = 60`

Every player still attached to the match is charged the round ante for accounting purposes.

- In a non-voided round, that ante stays in the round pot.
- In a voided round, the ante is refunded.

This ante is an internal integer database unit. It is not an onchain asset and has no financial value.

### 8.2 Valid reveals

A reveal is valid only if the player:

- was not already forfeited before the round began,
- committed during commit phase,
- revealed during reveal phase,
- passed commitment verification.

Only valid reveals participate in plurality counting.

### 8.3 Void rule

A round is voided only if:

- zero valid reveals exist.

Void-round rules:

- all round antes are refunded,
- no player receives coordination credit or incoherence credit for statistics,
- the round remains in round logs,
- no round winner is recorded.

Near-unanimity or perfect agreement does not void a round.

### 8.4 Exact-match plurality winners

Plurality counting uses exact option identity.

Definitions:

- `count(optionIndex)` = number of valid reveals for that exact option index,
- `topCount` = maximum count across revealed option indexes,
- `winningOptions` = every option index with `count(optionIndex) = topCount`.

Winner rule:

- a player wins the round iff they produced a valid reveal and their exact chosen option index is in `winningOptions`,
- a player loses the round iff they are attached to the round and do not win it.

Consequences:

- if exactly one player reveals, that player wins the whole pot,
- if multiple options tie for top count, all players on those tied top options win the round,
- missing commit or reveal is equivalent to losing the round.

### 8.5 Pot and payout

Definitions:

- `roundPlayerCount` = number of players still attached to the match for the round,
- `pot = roundPlayerCount * 60`,
- `winnerCount` = number of round winners in the round.

For a non-voided round:

- every attached player contributes 60 to the pot,
- round winners split the entire pot equally,
- round losers receive no round payout.

Per-player net round delta:

- round winner: `(pot / winnerCount) - 60`
- round loser: `-60`

Because the match size is restricted to 3, 5, or 7 and the ante is 60, equal splits of the full pot remain integer-valued in every allowed plurality outcome.

Economic consequence:

- if every attached player wins the round, each player gets back exactly their own ante and the net round delta is `0`,
- unanimous convergence and full top ties therefore count as successful coordination outcomes but are economically neutral rather than extra-rewarded outcomes,
- v1 intentionally rewards being on the winning side of disagreement rather than minting new value from perfect agreement.

### 8.6 Coordination credit

Round settlement and coordination measurement are intentionally not identical.

Definitions:

- `topCount` = maximum count across revealed option indexes from section 8.4,
- `validRevealCount` = number of valid reveals in the round,
- `coordination_credit` = whether the round demonstrates at least one shared winning choice.

Coordination-credit rule:

- a player earns coordination credit iff:
  - the round is non-voided,
  - the player won the round, and
  - `topCount >= 2`.

Consequences:

- rounds with `topCount = 1` still settle economically, but they do not count as evidence of successful coordination for statistics,
- this includes all-distinct rounds such as `1-1-1` and single-valid-reveal rounds,
- unanimous rounds do earn coordination credit because `topCount` is greater than or equal to `2`,
- tied pluralities such as `2-2-1` also award coordination credit to all round winners because at least one shared winning choice was observed, even though the group did not converge on a unique option,
- losing a non-voided round always breaks a streak,
- winning a round with `topCount = 1` does not extend a streak.

### 8.7 Balance update

For each player in each round:

`newBalance = oldBalance + roundDelta`

where:

- `roundDelta` is the plurality-round result from section 8.5.

Balances are integers and may go negative.

## 9. Question Design Policy

### 9.1 Product rule

Questions must test coordination behavior, not specialist knowledge.

Canonical prompts may rely on:

- subjective taste,
- social convention,
- everyday judgment,
- simple common knowledge that does not require lookup,
- broadly shared intuitions about categories, priorities, or symbolism.

Canonical prompts may not rely on:

- trivia,
- specialist or academic knowledge,
- exact dates,
- exact percentages,
- expert estimation.

Because the canonical public game uses exact-match plurality scoring, prompts should present discrete focal alternatives, not numeric scales.

### 9.2 Calibration prompts

The canonical pool may contain a small calibration subset of intentionally obvious prompts. Their role is to demonstrate strong convergence, not to trigger cancellation.

Calibration rules:

- calibration prompts are optional, not guaranteed,
- a 10-round match may contain at most 1 calibration prompt,
- calibration prompts must remain obvious to an ordinary player without lookup.

### 9.3 Current question-bank compliance

The current repository question bank is not fully canonical. At minimum, the following parts require replacement or rewrite before the public product claims compliance:

- all slider-based prompts,
- fact-heavy prompts such as current IDs `46`, `47`, `54`, `55`, `56`, `57`, `58`, `60`, `70`, and `75`,
- the current estimation block `86-100`.

### 9.4 Question-pool implications for coordination credit

Question design interacts with what the game can meaningfully claim as evidence of coordination.

Guidance:

- the pool should not overproduce all-distinct outcomes where every valid reveal lands on a different option,
- discrete alternatives should be few enough and salient enough that shared focal behavior can actually emerge,
- calibration prompts may intentionally create near-unanimity, but the full pool should also contain contested focal prompts that separate better and worse predictors of the group,
- telemetry should monitor `topCount` and full-disagreement rates so the pool can be tuned toward actual coordination behavior rather than pure dispersion.

## 10. Persistence And Leaderboard

### 10.1 Canonical persistent records

The canonical product persists at least these logical records:

- `accounts`
  - `account_id`
  - `display_name`
  - `token_balance`
  - `leaderboard_eligible`
  - `created_at`
- `player_stats`
  - `account_id`
  - `games_played`
  - `rounds_played`
  - `coherent_rounds`
  - `current_streak`
  - `longest_streak`
- `matches`
  - `match_id`
  - `started_at`
  - `ended_at`
  - `round_count`
  - `status`
- `match_players`
  - `match_id`
  - `account_id`
  - `display_name_snapshot`
  - `starting_balance`
  - `ending_balance`
  - `net_delta`
  - `result` (`completed`, `forfeited`)
- `vote_logs`
  - `id`
  - `match_id`
  - `round_number`
  - `question_id`
  - `account_id`
  - `display_name_snapshot`
  - `revealed_option_index`
  - `revealed_option_label`
  - `won_round`
  - `earns_coordination_credit`
  - `ante_amount`
  - `round_payout`
  - `net_delta`
  - `player_count`
  - `valid_reveal_count`
  - `top_count`
  - `winner_count`
  - `winning_option_indexes_json`
  - `voided`
  - `void_reason`
  - `timestamp`

### 10.2 Leaderboard semantics

Leaderboard ranking is based on current token balance among accounts that are eligible for the public leaderboard.

Definitions:

- `token_balance`: the account's current persisted internal token balance,
- `leaderboard_eligible`: whether the account is currently allowed to appear on the public leaderboard,
- `games_played`: count of completed public matches,
- `rounds_played`: count of non-voided rounds in completed public matches,
- `coherent_rounds`: count of non-voided completed-match rounds where the player earned coordination credit,
- `coherent_pct`: `coherent_rounds / rounds_played`, expressed as a percentage when `rounds_played > 0`, else `0`,
- `avg_net_tokens_per_game`: `token_balance / games_played` when `games_played > 0`, else `0`,
- `current_streak`: consecutive non-voided completed-match rounds with coordination credit. Resets on any losing round, forfeit, or non-voided round with `topCount = 1`,
- `longest_streak`: maximum historical `current_streak`.

Voided rounds:

- remain in `vote_logs`,
- do not change round ante balances,
- do not increment `rounds_played`,
- do not affect streaks,
- do not create coherent-round credit.

Non-voided rounds with `topCount = 1`:

- settle economically as specified in section 8,
- do increment `rounds_played`,
- do not create coherent-round credit,
- do not extend a streak,
- are intentionally treated as payout outcomes without evidence of successful coordination.

Presentation note:

- clients should present `wonRound` and `earnsCoordinationCredit` as separate concepts in round results and profile statistics,
- a player can win a round economically while earning no coordination credit,
- this is expected behavior, not an accounting error.

The public leaderboard is intentionally a balance-first surface:

- `token_balance` is the primary ranking signal,
- supplemental metrics such as `coherent_pct` and `avg_net_tokens_per_game` may be shown alongside it.

### 10.3 Leaderboard eligibility and abuse controls

The public leaderboard is operator-moderated, not purely append-only.

Rules:

- only accounts with `leaderboard_eligible = true` may appear on `/api/leaderboard`,
- the operator may set `leaderboard_eligible = false` for accounts suspected of self-play, linked-account play, sacrificial-alt farming, queue manipulation, or other ranking abuse,
- leaderboard eligibility may require minimum account age, minimum completed-match count, minimum opponent diversity, or other anti-abuse checks,
- the spec does not require leaderboard inclusion for every account with a token balance,
- an account may keep its internal token balance while being excluded from the public leaderboard.

This section mitigates ranking abuse, but it does not make the product trustlessly sybil resistant.

### 10.4 Leaderboard ordering

Canonical `/api/leaderboard` ordering:

1. `token_balance` descending
2. `coherent_rounds` descending
3. `display_name` ascending

### 10.5 Token properties

Canonical public tokens are:

- application-managed database balances,
- non-transferable between arbitrary users except through game settlement,
- not ERC20 tokens,
- not redeemable,
- not intended to have financial value.

### 10.6 Vote export

`/api/export/votes.csv` must export the canonical round-log schema. The canonical CSV columns are:

`id,match_id,round_number,question_id,account_id,display_name,revealed_option_index,revealed_option_label,won_round,earns_coordination_credit,ante_amount,round_payout,net_delta,player_count,valid_reveal_count,top_count,winner_count,winning_option_indexes,voided,void_reason,timestamp`

## 11. Public API Contract

### 11.1 REST endpoints

#### `GET /api/leaderboard`

Response body:

```json
[
  {
    "rank": 1,
    "displayName": "alice",
    "tokenBalance": 420,
    "leaderboardEligible": true,
    "gamesPlayed": 8,
    "avgNetTokensPerGame": 52.5,
    "roundsPlayed": 80,
    "coherentRounds": 29,
    "coherentPct": 36,
    "currentStreak": 3,
    "longestStreak": 6
  }
]
```

#### `GET /api/leaderboard/me`

Rules:

- Requires an authenticated session.
- Does not accept a `username` query parameter.

Response body:

```json
{
  "rank": 5,
  "displayName": "alice",
  "tokenBalance": 180,
  "leaderboardEligible": true,
  "gamesPlayed": 4,
  "avgNetTokensPerGame": 45,
  "roundsPlayed": 40,
  "coherentRounds": 14,
  "coherentPct": 35,
  "currentStreak": 2,
  "longestStreak": 5
}
```

#### `GET /api/export/votes.csv`

Rules:

- Returns canonical CSV described in section 10.6.
- Access control is deployment-specific. At minimum it is an operator-facing endpoint, not a gameplay dependency.

### 11.2 WebSocket connection rules

- WebSocket requires the authenticated same-origin session established by auth.
- If the session is missing or invalid, the server sends an `error` and closes the socket.
- All gameplay state transitions are server-authoritative.

### 11.3 Client -> server messages

#### `join_queue`

```json
{
  "type": "join_queue"
}
```

Effects:

- enqueue player if eligible,
- set `auto_requeue = true` for the current session,
- emit `queue_state`.

#### `leave_queue`

```json
{
  "type": "leave_queue"
}
```

Effects:

- remove player from queue or forming match if not yet started,
- set `auto_requeue = false` for the current session,
- emit updated `queue_state`.

#### `commit`

```json
{
  "type": "commit",
  "hash": "64-char sha256 hex"
}
```

Rules:

- Allowed only during commit phase.
- One commitment per player per round.

#### `reveal`

```json
{
  "type": "reveal",
  "optionIndex": 2,
  "salt": "0123abcd..."
}
```

Rules:

- Allowed only during reveal phase.
- `optionIndex` must be the exact committed zero-based option index.
- `salt` must be hexadecimal and at least 32 characters long.

#### `chat`

```json
{
  "type": "chat",
  "text": "message"
}
```

Rules:

- Allowed only during commit phase.
- `text` length cap: 300 characters.

### 11.4 Server -> client messages

#### `queue_state`

```json
{
  "type": "queue_state",
  "status": "queued",
  "autoRequeue": true,
  "queuedCount": 6,
  "queuedPlayers": ["alice", "bob", "carol", "dave", "erin", "frank"],
  "formingMatch": {
    "playerCount": 6,
    "players": ["alice", "bob", "carol", "dave", "erin", "frank"],
    "allowedSizes": [3, 5, 7],
    "fillDeadlineMs": 1774261200000
  }
}
```

Notes:

- `formingMatch` is `null` when no fill timer is active.
- `queuedPlayers` reflects all currently queued players in FIFO order.

#### `game_started`

```json
{
  "type": "game_started",
  "matchId": "match_123",
  "roundCount": 10,
  "players": [
    { "displayName": "alice", "startingBalance": 180 },
    { "displayName": "bob", "startingBalance": -60 },
    { "displayName": "carol", "startingBalance": 0 }
  ]
}
```

#### `round_start`

```json
{
  "type": "round_start",
  "round": 1,
  "question": {
    "id": 1,
    "text": "Pick the color of trust.",
    "type": "select",
    "options": ["Blue", "Green", "Red", "Yellow"]
  },
  "commitDuration": 30,
  "roundAnte": 60,
  "phase": "commit"
}
```

Question contract rules:

- `options` are exact discrete choices,
- option order is stable within the round,
- scoring depends on exact option identity, not numeric distance.

#### `commit_status`

```json
{
  "type": "commit_status",
  "committed": [
    { "displayName": "alice", "hasCommitted": true }
  ]
}
```

#### `phase_change`

```json
{
  "type": "phase_change",
  "phase": "reveal",
  "revealDuration": 15
}
```

#### `reveal_status`

```json
{
  "type": "reveal_status",
  "revealed": [
    { "displayName": "alice", "hasRevealed": true }
  ]
}
```

#### `round_result`

```json
{
  "type": "round_result",
  "result": {
    "roundNum": 1,
    "voided": false,
    "voidReason": null,
    "playerCount": 5,
    "pot": 300,
    "winningOptionIndexes": [0],
    "winnerCount": 3,
    "payoutPerWinner": 100,
    "players": [
      {
        "displayName": "alice",
        "revealedOptionIndex": 0,
        "wonRound": true,
        "earnsCoordinationCredit": true,
        "antePaid": 60,
        "roundPayout": 100,
        "netDelta": 40,
        "newBalance": 220
      }
    ]
  }
}
```

Notes:

- `wonRound` and `earnsCoordinationCredit` are intentionally separate fields,
- `wonRound = true` with `earnsCoordinationCredit = false` is valid when `topCount = 1`,
- clients should not derive one field from the other.

#### `game_over`

```json
{
  "type": "game_over",
  "summary": {
    "players": [
      {
        "displayName": "alice",
        "startingBalance": 180,
        "endingBalance": 420,
        "netDelta": 240,
        "result": "completed"
      }
    ]
  }
}
```

#### `player_disconnected`

```json
{
  "type": "player_disconnected",
  "displayName": "alice",
  "graceSeconds": 15
}
```

Notes:

- This message is informational only.
- It does not pause the current round timer for other players.
- It does not imply that the disconnected player will be allowed to act after the phase closes.

#### `player_reconnected`

```json
{
  "type": "player_reconnected",
  "displayName": "alice"
}
```

#### `player_forfeited`

```json
{
  "type": "player_forfeited",
  "displayName": "alice",
  "autoLosesRemainingRounds": true
}
```

#### `chat`

```json
{
  "type": "chat",
  "from": "alice",
  "text": "blue obviously",
  "messageId": "msg_123"
}
```

#### `error`

```json
{
  "type": "error",
  "message": "Human-readable explanation"
}
```

## 12. Conformance Scenarios

An implementation conforms to this spec only if all of the following behaviors hold:

- Public queue is FIFO and visible by `display_name`.
- Public matches use odd sizes only: 3, 5, or 7.
- A 20-second fill timer starts when the third player is reserved.
- If fill expiry lands on an even reserved size, the largest lower odd size starts and the most recent extras return to queue.
- When alternatives exist, immediate rematches against players from the immediately previous completed match are avoided.
- No host or room-code flow exists in the public product.
- Public matches are fixed at 10 rounds.
- Questions in the public mode are `select` only.
- Scoring uses exact-match plurality, not mean-distance or sigma bands.
- A single valid revealer wins the whole round pot.
- Tied top options all count as winning options and split the full pot.
- A round is voided only when zero valid reveals exist.
- Near-unanimity and full agreement do not cancel a round.
- Every attached player contributes 60 to each non-voided round.
- Token balances persist across games, start at 0 for new accounts, and may go negative.
- Public leaderboard visibility is abuse-filtered and operator-moderated.
- Rounds with `topCount = 1` settle economically but do not award coordination credit or extend streaks.
- Disconnect during active play opens a 15-second reconnect grace without pausing timers.
- A forfeited player auto-loses ordinary subsequent rounds and is not auto-requeued.

## 13. Current Implementation Gaps

The current repository is a prototype and does not yet implement this public-product spec. The largest gaps are:

- room-code rooms instead of a global public queue,
- manual host-controlled start instead of automatic matchmaking,
- guest usernames instead of wallet-backed accounts,
- no account-backed persistent token balance,
- round-count selection instead of a fixed 10-round public format,
- support for slider questions instead of select-only public mode,
- mean-and-sigma settlement instead of exact-match plurality scoring,
- sigma-based round cancellation instead of a zero-valid-reveal-only void rule,
- no odd-size-only public match formation for 3, 5, or 7,
- no even-group pushback rule at fill expiry,
- current per-round stake logic differs from the fixed 60-ante model,
- balances currently reset per game instead of persisting from account creation,
- no abuse-filtered leaderboard eligibility controls,
- no distinction between payout wins and coordination-credit statistics,
- `/api/leaderboard/me` is still keyed by client-supplied username,
- current CSV/export fields still reflect the old round-scoring model.

## 14. Assumptions

- Wallet auth is Ethereum-compatible in v1.
- The public queue is same-region and same-deployment only in v1. Cross-region matchmaking is out of scope.
- Queue visibility shows `display_name` only. Wallet addresses remain private outside authenticated account management.
- The product operator is allowed to use ordinary service subjectivity, moderation, and abuse controls. The spec does not require trustless objective finality.
- This spec defines the intended product contract. The existing codebase is expected to evolve toward it incrementally.
