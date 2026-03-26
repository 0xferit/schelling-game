# Schelling Game

Multiplayer coordination game where players independently pick the option they expect the most other players to pick. Answers are committed with a hash, revealed, and settled by exact-match plurality. Dual-mode deployment: Express for local dev, Cloudflare Workers + Durable Objects for production.

## Tech Stack

- TypeScript 6 (strict mode), Node.js 24
- Express 5 + ws (dev server), Cloudflare Workers + Durable Objects + D1 (production)
- better-sqlite3 (local persistence), ethers.js (wallet auth via EIP-191)
- Biome (formatter + linter)

## Getting Started

```sh
npm ci
npm run dev          # Express dev server on port 3000 (watch mode)
npm test             # Unit tests (domain logic)
npm run lint         # Biome check (lint + format)
```

## Type Checking

Two TypeScript configs exist because the Node server and the Cloudflare Worker have different type environments:

```sh
npm run typecheck          # Node/Express code (tsconfig.json)
npm run typecheck:worker   # Worker code (tsconfig.worker.json)
```

Both must pass before committing. CI enforces this.

## Code Style

Biome handles formatting and linting. Key settings:

- 2-space indentation, single quotes
- Import organization is automatic
- Config: `biome.json`

Auto-fix: `npx biome check --write .`

## Architecture

```
src/
  worker.ts              # Cloudflare Worker entry point (Durable Object: GameRoom)
  auth.ts                # EIP-191 wallet signature verification
  db.ts                  # SQLite abstraction (singleton, WAL mode)
  gameManager.ts         # Match and round orchestration
  matchmaking.ts         # Queue logic (match sizes: 3, 5, or 7)
  domain/
    commitReveal.ts      # SHA-256 commit-reveal crypto
    questions.ts         # Question pool and selection
    settlement.ts        # Plurality settlement and payouts
  types/
    domain.ts            # Core game types
    db.ts                # Database schema types
    messages.ts          # WebSocket protocol (ClientMessage / ServerMessage)
    worker-env.ts        # Cloudflare env bindings
server.ts                # Express dev/staging server
public/                  # Static frontend (vanilla JS + ethers.js)
test/                    # Unit tests
```

Two entry points: `server.ts` for dev (Express + ws + SQLite), `src/worker.ts` for production (Workers + Durable Objects + D1). Domain logic in `src/domain/` is shared between both.

## Game Rules

`docs/game-design.md` is the canonical, authoritative game rules document. Defer to it for any gameplay behavior questions. Do not duplicate or paraphrase game rules elsewhere.

## Architecture Decisions

`docs/adr/` contains architecture decision records. Read the relevant ADR before modifying a subsystem it covers.

## Testing

```sh
npm test
```

Runs `test/test.ts` via tsx. No external test framework; uses custom assertions. Tests cover commit-reveal verification, settlement logic, and question pool structure.

## Deployment

Production runs on Cloudflare Workers. `npm run deploy` stamps build metadata into HTML, deploys via Wrangler, then restores the HTML.

CI (GitHub Actions):
- PRs: lint, typecheck (both configs), tests
- Push to main: build + deploy
