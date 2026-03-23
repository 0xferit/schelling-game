# Implementation Plan For Canonical Public Schelling Game

Status: execution plan for the canonical public-product spec in `docs/game-spec.md`

## 1. Goal

Replace the current room-code prototype with the canonical public product:

- wallet-backed persistent accounts
- visible public matchmaking queue
- odd-size public matches of 3, 5, or 7
- select-only focal-point questions
- exact-match plurality scoring
- persistent internal token balances
- coordination-credit statistics distinct from payout outcomes
- abuse-filtered public leaderboard

This plan is for the educational offchain game described in the spec. It is not a plan for a trustless oracle or a sybil-resistant ranking protocol.

## 2. Delivery Strategy

### 2.1 Recommended implementation order

Implement the canonical product in the Node stack first:

- `server.js`
- `src/gameManager.js`
- `src/gameLogic.js`
- `src/db.js`
- `public/index.html`
- `test/test.js`

Defer `src/worker.js` until the Node implementation reaches spec parity.

Reason:

- the current repository duplicates backend behavior in the Node server and the Cloudflare Worker
- implementing both in parallel will create avoidable drift during a large rewrite
- the Node path is the faster route to a reference implementation because it already has local SQLite, Express, and a simpler debugging loop

### 2.2 Success criteria

The implementation is ready for the first public test only when:

1. public queue and match formation behave according to the spec
2. round settlement matches the canonical plurality rules
3. persistent balances and coordination-credit stats are correct
4. the UI no longer exposes room codes, host start, sliders, or leak-report flows
5. the old mean/sigma behavior is fully removed from the active path

## 3. Current Codebase Mapping

### 3.1 Current prototype components

- `server.js`: Express server, REST API, static file serving, Node WebSocket entrypoint
- `src/gameManager.js`: room-code lobby flow, phase management, in-memory room state
- `src/gameLogic.js`: mean/sigma scoring, leak-report handling, balance changes
- `src/db.js`: simple `players` and `vote_logs` schema keyed by username
- `src/questions.js`: mixed slider/select pool, includes non-canonical estimation and fact-heavy prompts
- `public/index.html`: single-file UI built around room codes, host start, sliders, and old result fields
- `src/worker.js`: second backend implementation with the same old room-code assumptions
- `test/test.js`: tests for the old mean/sigma engine

### 3.2 Main implementation mismatch

The current code assumes:

- rooms instead of one public queue
- usernames instead of wallet-backed accounts
- per-game reset balances instead of persistent balances
- mean/sigma scoring instead of plurality
- slider support instead of select-only public mode
- leak-report mechanics instead of the current moderation-only v1

This is a rewrite of the gameplay core, not a small patch.

## 4. Implementation Principles

### 4.1 Single source of truth

Extract the canonical rules into pure server-side modules before wiring UI behavior around them.

Recommended module split:

- `src/domain/matchmaking.js`
- `src/domain/commitReveal.js`
- `src/domain/settlement.js`
- `src/domain/stats.js`
- `src/domain/questions.js`

`src/gameManager.js` should become orchestration code, not the home of core rules.

### 4.2 Keep payout and coordination metrics separate

The implementation must preserve two independent concepts:

- `wonRound`
- `earnsCoordinationCredit`

Do not derive one from the other in the backend or the client.

### 4.3 Ship the honest product first

V1 should implement:

- public queue
- plurality settlement
- persistent balances
- moderation hooks

V1 should not attempt:

- trustless sybil resistance
- in-protocol leak betting
- weighted ticket draws
- onchain token semantics

## 5. Workstreams

### 5.1 Data model and persistence

Replace the current DB schema with canonical records close to the spec:

- `accounts`
- `player_stats`
- `matches`
- `match_players`
- `vote_logs`
- `auth_challenges`
- session storage or equivalent authenticated-session support

Required schema changes:

- account key becomes wallet address, not username
- `display_name` becomes a unique profile field
- `token_balance` becomes persistent signed integer state
- add `leaderboard_eligible`
- add `won_round` and `earns_coordination_credit` fields to logs
- add `valid_reveal_count`, `top_count`, and `winning_option_indexes`

Implementation tasks:

1. add migrations in `src/db.js`
2. keep backward-compatible local dev initialization simple
3. add DB helpers for leaderboard eligibility, match creation, per-round log inserts, and stats updates
4. add a one-time reset path for local development if old prototype tables exist

### 5.2 Authentication and session handling

Add canonical auth endpoints:

- `POST /api/auth/challenge`
- `POST /api/auth/verify`
- `GET /api/me`
- `PATCH /api/me/profile`

Implementation tasks:

1. create nonce-based challenge storage
2. verify Ethereum-compatible signatures
3. issue authenticated same-origin session cookies
4. require authenticated session for queue entry and `/api/leaderboard/me`
5. block profile changes while queued, forming, or in match

Recommended shipping approach:

- implement real wallet verification in production mode
- allow a clearly marked development shortcut only under an explicit dev flag

### 5.3 Matchmaking service

Replace room creation and host start with one global queue.

Required behaviors:

- FIFO queue
- visible waiting room roster
- one forming match at a time
- 20-second fill timer starting at 3 players
- allowed match sizes 3, 5, 7
- push even extras back to queue on fill expiry
- anti-repeat based on immediately previous completed match
- auto-requeue toggle

Implementation tasks:

1. replace the `rooms` map with queue state plus active match registry
2. model queued, forming, active, and summary states explicitly
3. emit canonical `queue_state`, `game_started`, `player_disconnected`, `player_reconnected`, and `player_forfeited` events
4. remove `join`, `start_game`, and `room_state` semantics from the public path

### 5.4 Match engine rewrite

Replace the current settlement engine entirely.

Required behaviors:

- commit preimage is `${optionIndex}:${salt}`
- select-only questions
- 60 ante per attached player
- zero valid reveals => void round with refunded antes
- one valid revealer => economic win but no coordination credit
- plurality winners split the full pot
- `topCount >= 2` gates coordination credit
- forfeited players remain attached for accounting and auto-lose later ordinary rounds

Implementation tasks:

1. replace `computeRoundResult` with plurality settlement
2. replace `applyBalanceChanges` with persistent signed-integer balance updates
3. remove all mean/sigma, leak-report, and stake-cap logic from the active engine
4. enforce salt length >= 32 hex chars
5. emit result payloads with:
   - `winningOptionIndexes`
   - `winnerCount`
   - `wonRound`
   - `earnsCoordinationCredit`
   - `topCount`
   - `validRevealCount`

### 5.5 Question system

Replace the current question bank with a spec-compliant select-only pool.

Implementation tasks:

1. delete or archive slider questions from the public path
2. remove fact-heavy and estimation-heavy prompts from the shipping pool
3. keep question metadata minimal but useful:
   - `id`
   - `text`
   - `type`
   - `options`
   - optional tags for moderation and telemetry
4. add a lightweight validation script or test that rejects non-select public questions

### 5.6 Frontend rewrite

The current single-file UI should be treated as a prototype shell and updated to the canonical product flow.

Required UI changes:

- wallet sign-in and display-name claim
- public waiting room instead of room code entry
- no host-only start button
- no slider controls
- no leak reporting UI
- queue and auto-requeue controls
- result cards showing both payout outcome and coordination credit
- leaderboard messaging that makes moderation and non-trustless ranking explicit

Implementation tasks:

1. replace lobby form with auth + queue flow
2. rebuild player state panels around queue/match identity
3. replace old result labels such as `coherent` with:
   - `wonRound`
   - `earnsCoordinationCredit`
4. add copy that explains why a player can win a round without extending a streak

### 5.7 Leaderboard and moderation

Implement the public leaderboard as a moderated product surface.

Implementation tasks:

1. store `leaderboard_eligible`
2. make `/api/leaderboard` return only eligible accounts
3. make `/api/leaderboard/me` return the authenticated account plus eligibility state
4. expose at least one operator workflow for toggling eligibility

Initial moderation tooling can be simple:

- direct DB flag update
- protected internal endpoint
- or a basic admin script

Do not block implementation on a full admin UI.

### 5.8 Cloudflare Worker parity

After Node parity:

Option A:

- port the canonical backend to `src/worker.js`

Option B:

- extract shared pure domain modules and use them from both runtimes

Recommended choice:

- get Node green first
- then decide whether the Worker path is still worth maintaining

## 6. Phase Plan

### Phase 0: Foundations

Deliverables:

- implementation plan committed
- clear decision that Node is the reference path
- issue breakdown from this document

### Phase 1: Schema and auth

Deliverables:

- new DB schema
- wallet challenge/verify flow
- authenticated session support
- `GET /api/me`

Acceptance gate:

- a new user can sign in, claim a display name, and persist an account row

### Phase 2: Core match engine

Deliverables:

- pure plurality settlement module
- pure coordination-credit stats module
- new round result shape

Acceptance gate:

- engine tests pass for:
  - plurality winners
  - tied pluralities
  - one-valid-revealer outcomes
  - zero-valid-reveal voids
  - forfeit accounting
  - streak and coordination-credit behavior

### Phase 3: Queue and WebSocket flow

Deliverables:

- public queue
- forming match timer
- 3/5/7 auto-start
- reconnect and forfeit handling

Acceptance gate:

- three browser sessions can authenticate, queue, auto-form a match, play a round, and receive canonical result payloads

### Phase 4: Frontend parity

Deliverables:

- new lobby/waiting-room UI
- new round/result UI
- summary and leaderboard UI aligned with spec

Acceptance gate:

- no room-code, host-start, slider, or leak-report flows remain visible in the public path

### Phase 5: Stats, exports, and moderation

Deliverables:

- canonical leaderboard responses
- canonical CSV export shape
- `leaderboard_eligible` workflow

Acceptance gate:

- balance, coherent-round stats, streaks, and export rows all match spec examples

### Phase 6: Worker decision

Deliverables:

- either Worker parity plan and implementation
- or an explicit decision to de-scope/remove the Worker path

Acceptance gate:

- one deployment path is canonical and maintained

## 7. Test Plan

### 7.1 Replace the old engine tests

`test/test.js` currently validates the prototype mean/sigma logic. Replace it with tests for:

- commit hash verification with option index + salt
- zero-valid-reveal void
- single-valid-revealer economic win without coordination credit
- 2-1, 2-2-1, 3-2, 3-3-1, and unanimous outcomes
- tied top options
- persistent negative balances
- forfeit bleed across remaining rounds
- coordination-credit streak behavior

### 7.2 Add API tests

Add coverage for:

- auth challenge/verify
- `/api/me`
- `/api/leaderboard`
- `/api/leaderboard/me`
- `/api/export/votes.csv`

### 7.3 Add flow tests

At minimum, add integration scenarios for:

- queue fill to 3
- fill to 5 and 7
- even-size pushback at timer expiry
- anti-repeat fallback behavior
- reconnect before and after phase closure
- auto-requeue toggle

## 8. Recommended First Build Slice

The fastest end-to-end slice is:

1. persistent accounts and `GET /api/me`
2. public queue and one 3-player match
3. select-only plurality settlement
4. basic results and summary screens
5. leaderboard read path

Do not start with:

- Worker parity
- admin UI
- large question-pool curation tooling

## 9. Open Implementation Decisions

These do not block starting work, but they should be settled before shipping:

- which Ethereum wallet sign-in pattern to use in the browser
- whether leaderboard eligibility defaults to manual review or simple automatic heuristics
- whether `src/worker.js` remains a supported target after Node parity
- whether the UI should expose coordination-credit explanations inline, in a help modal, or both

## 10. Recommended Next Step

Turn this document into concrete tracked work:

1. create implementation tickets for phases 1-5
2. start with schema/auth plus engine rewrite
3. keep the Worker path frozen until the Node reference implementation passes the new acceptance tests
