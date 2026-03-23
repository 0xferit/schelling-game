# Ticket Breakdown For Canonical Public Schelling Game

Status: proposed implementation backlog derived from `docs/implementation-plan.md`

## 1. Use

This document breaks the implementation plan into executable tickets.

Conventions:

- ticket IDs use the prefix `SG-`
- dependencies list the ticket IDs that should land first
- “touches” identifies the primary files or modules expected to change
- “acceptance” is the minimum bar for closing the ticket

Recommended execution rule:

- treat the Node stack as the reference implementation
- keep `src/worker.js` frozen until the Node path reaches canonical spec parity

## 2. Epic Overview

### Epic A: Foundation and schema

- `SG-001` through `SG-004`, plus `SG-023`

### Epic B: Core game engine

- `SG-005` through `SG-009`

### Epic C: Matchmaking and WebSocket contract

- `SG-010` through `SG-013`

### Epic D: Frontend rewrite

- `SG-014` through `SG-017`

### Epic E: Moderation, exports, and rollout

- `SG-018` through `SG-021`

### Epic F: Worker decision

- `SG-022`

## 3. Tickets

### SG-001: Freeze Worker path and declare Node reference backend

Dependencies:

- none

Touches:

- [docs/implementation-plan.md](/Users/ferit/Documents/Projects/0xferit/schelling-game/docs/implementation-plan.md)
- [README.md](/Users/ferit/Documents/Projects/0xferit/schelling-game/README.md)

Scope:

- explicitly treat `server.js` + `src/*` as the active rewrite path
- mark `src/worker.js` as deferred in planning notes
- avoid dual-backend feature work during phases 1-5

Acceptance:

- planning docs clearly say Node is the reference path
- no new canonical-product work is started in `src/worker.js`

### SG-023: Add minimal CI to run the test suite

Dependencies:

- `SG-001`

Touches:

- new CI config under `.github/workflows/`
- [package.json](/Users/ferit/Documents/Projects/0xferit/schelling-game/package.json)

Scope:

- add a basic CI workflow that runs `npm test`
- make the rewrite observable as old tests are replaced by canonical ones

Acceptance:

- pushes and pull requests run `npm test` automatically
- CI stays green on the current base branch before engine rewrite work starts

### SG-002: Replace DB schema with canonical account and match tables

Dependencies:

- `SG-001`

Touches:

- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)

Scope:

- add canonical tables for `accounts`, `player_stats`, `matches`, `match_players`, `vote_logs`, and `auth_challenges`
- add `leaderboard_eligible`
- add canonical vote-log fields such as `won_round`, `earns_coordination_credit`, `valid_reveal_count`, `top_count`, and `winning_option_indexes`
- add a simple local reset/migration strategy for old prototype DBs

Acceptance:

- local startup creates the new schema successfully
- DB helper methods exist for account upsert/load, match creation, round logging, stats updates, and leaderboard queries

### SG-003: Implement wallet auth challenge and session flow

Dependencies:

- `SG-002`

Touches:

- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js)
- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)
- new auth helpers under `src/`

Scope:

- add `POST /api/auth/challenge`
- add `POST /api/auth/verify`
- verify Ethereum-compatible signatures
- establish authenticated same-origin sessions

Acceptance:

- a client can request a challenge, sign it, verify it, and obtain a persisted account-backed session

### SG-004: Implement profile and self-service account endpoints

Dependencies:

- `SG-003`

Touches:

- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js)
- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)

Scope:

- add `GET /api/me`
- add `PATCH /api/me/profile`
- enforce unique display names
- block display-name changes while queued, forming, or active

Acceptance:

- authenticated users can claim a unique display name
- `/api/me` returns account ID, display name, token balance, leaderboard eligibility, auto-requeue, and queue status

### SG-005: Replace public question pool with select-only canonical pool

Dependencies:

- `SG-001`

Touches:

- [src/questions.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/questions.js)
- tests or validation helper

Scope:

- remove sliders from the public path
- remove fact-heavy and estimation-heavy prompts from the shipping pool
- keep only select questions that fit the common-knowledge focal-point policy

Acceptance:

- the active public question set is select-only
- a validation test fails if slider questions enter the public pool

### SG-006: Implement canonical commit-reveal primitives

Dependencies:

- `SG-005`

Touches:

- [src/gameLogic.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameLogic.js) or extracted domain module

Scope:

- commit preimage becomes `${optionIndex}:${salt}`
- enforce salt length >= 32 hex chars
- verify option-index reveals against commit hash

Acceptance:

- unit tests cover valid commit, wrong option index, wrong salt, wrong hash, and short-salt rejection

### SG-007: Replace mean/sigma settlement with plurality settlement

Dependencies:

- `SG-006`

Touches:

- [src/gameLogic.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameLogic.js)

Scope:

- remove mean, sigma, weight caps, and leak handling from the active engine
- implement:
  - fixed 60 ante
  - full-pot payout to plurality winners
  - zero-valid-reveal void
  - one-valid-revealer economic win
  - tied plurality winners
  - `topCount >= 2` coordination credit

Acceptance:

- engine returns canonical result fields:
  - `winningOptionIndexes`
  - `winnerCount`
  - `wonRound`
  - `earnsCoordinationCredit`
  - `validRevealCount`
  - `topCount`

### SG-008: Implement persistent balance and stat updates

Dependencies:

- `SG-002`
- `SG-007`

Touches:

- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)
- settlement orchestration in [src/gameManager.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameManager.js)

Scope:

- update persistent signed balances after every round
- write canonical vote logs
- update `games_played`, `rounds_played`, `coherent_rounds`, `current_streak`, and `longest_streak`
- keep payout and coordination-credit updates separate

Acceptance:

- round outcomes persist correctly across match boundaries
- single-valid-revealer rounds affect balance but not coordination credit

### SG-009: Replace old engine tests with canonical-game tests

Dependencies:

- `SG-006`
- `SG-007`
- `SG-008`

Touches:

- [test/test.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/test/test.js)

Scope:

- remove prototype mean/sigma tests
- add pure engine tests for:
  - plurality settlement
  - tied pluralities
  - single-valid-revealer outcome
  - zero-valid-reveal void
  - coordination-credit stats
- keep reconnect, forfeit-flow, and early-termination scenarios out of this ticket; cover them in `SG-012` and `SG-021`

Acceptance:

- `npm test` validates the canonical engine rather than the retired prototype rules

### SG-010: Replace room-code lobbies with one public queue model

Dependencies:

- `SG-004`

Touches:

- [src/gameManager.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameManager.js)

Scope:

- remove room-code creation/joining from the public path
- add global queue, forming match, and active match registries
- add queue statuses and visible waiting-room roster behavior

Acceptance:

- authenticated users can join and leave one global public queue
- no host or room-code concepts remain in the public flow

### SG-011: Implement forming-match timer and 3/5/7 auto-start rules

Dependencies:

- `SG-010`

Touches:

- [src/gameManager.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameManager.js)

Scope:

- start a 20-second fill timer when the third player is reserved
- grow a forming match up to 7
- on timer expiry:
  - start 7 if available
  - else 5 if 5 or 6 reserved
  - else 3 if 3 or 4 reserved
- push even extras back to the queue in existing relative order

Acceptance:

- queue simulation confirms correct 3/5/7 formation and even-size pushback

### SG-012: Implement anti-repeat matchmaking, reconnects, forfeits, and auto-requeue

Dependencies:

- `SG-010`
- `SG-011`
- `SG-008`

Touches:

- [src/gameManager.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameManager.js)

Scope:

- avoid immediate rematches when alternatives exist
- handle disconnects while queued or forming according to the canonical spec
- support 15-second reconnect grace without pausing timers
- keep forfeited players attached for accounting
- implement early match termination when no non-forfeited players remain able to reveal future rounds
- support session-level auto-requeue

Acceptance:

- reconnect and forfeit scenarios match the canonical spec
- non-forfeited players auto-requeue when enabled

### SG-013: Rewrite WebSocket contract to canonical public messages

Dependencies:

- `SG-010`
- `SG-011`
- `SG-012`
- `SG-007`

Touches:

- [src/gameManager.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/gameManager.js)
- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js)

Scope:

- replace old message contract with canonical queue/match messages
- remove `join`, `start_game`, `report_leak`, and room-centric state payloads from the public path
- emit canonical result payloads with `wonRound` and `earnsCoordinationCredit`

Acceptance:

- WebSocket traffic matches the spec’s public contract

### SG-014: Implement auth, profile, and queue frontend flow

Dependencies:

- `SG-003`
- `SG-004`
- `SG-010`

Touches:

- [public/index.html](/Users/ferit/Documents/Projects/0xferit/schelling-game/public/index.html)

Scope:

- replace username + room-code entry with wallet sign-in and display-name claim
- add public queue and waiting-room UI
- add auto-requeue toggle

Acceptance:

- the public UI no longer exposes room codes or host start

### SG-015: Rewrite play UI for select-only plurality rounds

Dependencies:

- `SG-005`
- `SG-006`
- `SG-013`

Touches:

- [public/index.html](/Users/ferit/Documents/Projects/0xferit/schelling-game/public/index.html)

Scope:

- remove slider UI
- remove leak-report UI
- render select options only
- render commit and reveal flow against the new contract

Acceptance:

- a player can complete a full canonical round through the browser

### SG-016: Rewrite results and summary UI around payout vs coordination credit

Dependencies:

- `SG-013`
- `SG-015`

Touches:

- [public/index.html](/Users/ferit/Documents/Projects/0xferit/schelling-game/public/index.html)

Scope:

- render `wonRound` and `earnsCoordinationCredit` distinctly
- explain why a player can win a round without extending a streak
- update summary screens to use persistent balances

Acceptance:

- result screens clearly differentiate economic win from coordination credit

### SG-017: Frontend leaderboard rewrite

Dependencies:

- `SG-004`
- `SG-018`

Touches:

- [public/index.html](/Users/ferit/Documents/Projects/0xferit/schelling-game/public/index.html)

Scope:

- render canonical leaderboard fields
- show leaderboard eligibility state for the current user
- explain that leaderboard ranking is moderated and not trustlessly sybil resistant

Acceptance:

- leaderboard UI matches the canonical product framing

### SG-018: Implement canonical leaderboard endpoints and moderation flag

Dependencies:

- `SG-002`
- `SG-003`
- `SG-008`

Touches:

- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js)
- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)

Scope:

- make `/api/leaderboard` return only eligible accounts
- make `/api/leaderboard/me` use the authenticated session instead of a username query param
- include `leaderboardEligible` in responses

Acceptance:

- leaderboard API matches the canonical response shape and eligibility semantics

### SG-019: Implement canonical CSV export

Dependencies:

- `SG-008`

Touches:

- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js)
- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)

Scope:

- export canonical CSV columns from the new vote-log schema
- remove old mean/sigma export fields from the public export path

Acceptance:

- `/api/export/votes.csv` matches the spec’s canonical column list

### SG-020: Add minimal operator workflow for leaderboard eligibility

Dependencies:

- `SG-018`

Touches:

- [server.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/server.js) or internal script
- [src/db.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/db.js)

Scope:

- provide one simple way to toggle `leaderboard_eligible`
- this can be a protected endpoint, script, or manual admin utility

Acceptance:

- operator can exclude a known abusive account from `/api/leaderboard` without DB hand-editing

### SG-021: End-to-end QA pass against the canonical spec

Dependencies:

- `SG-009`
- `SG-013`
- `SG-017`
- `SG-018`
- `SG-019`

Touches:

- tests and QA docs

Scope:

- run end-to-end scenarios for:
  - 3-player match
  - 5-player tie
  - 7-player formation
  - even-size pushback
  - reconnect and forfeit
  - single-valid-revealer payout without coordination credit
- verify REST, WebSocket, DB, and UI consistency

Acceptance:

- canonical acceptance scenarios pass locally

### SG-022: Decide Worker parity or de-scope

Dependencies:

- `SG-021`

Touches:

- [src/worker.js](/Users/ferit/Documents/Projects/0xferit/schelling-game/src/worker.js)
- planning docs

Scope:

- either port the canonical implementation to the Worker path
- or explicitly de-scope/remove the Worker backend

Acceptance:

- one deployment path is clearly canonical and maintained

## 4. Suggested Milestones

### Milestone 1: Account foundation

- `SG-001`
- `SG-023`
- `SG-002`
- `SG-003`
- `SG-004`

### Milestone 2: Canonical engine

- `SG-005`
- `SG-006`
- `SG-007`
- `SG-008`
- `SG-009`

### Milestone 3: Queue and transport

- `SG-010`
- `SG-011`
- `SG-012`
- `SG-013`

### Milestone 4: Public UI

- `SG-014`
- `SG-015`
- `SG-016`
- `SG-017`

### Milestone 5: Public stats and rollout

- `SG-018`
- `SG-019`
- `SG-020`
- `SG-021`

### Milestone 6: Deployment-path decision

- `SG-022`

## 5. Recommended First Tickets

If work starts immediately, start in this order:

1. `SG-002`
2. `SG-023`
3. `SG-005`
4. `SG-003`
5. `SG-004`
6. `SG-006`
7. `SG-007`
8. `SG-008`
9. `SG-009`

Reason:

- schema/auth plus engine rewrite are the critical path
- CI should be in place before the old tests are replaced
- the frontend and queue work are cheaper once the canonical payloads are stable
