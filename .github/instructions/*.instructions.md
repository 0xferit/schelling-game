---
applyTo: "**"
---

# Schelling Game

Multiplayer coordination game where players independently pick the option they expect the most other players to pick. Answers are committed with a hash, revealed, and settled by exact-match plurality. Runs on Cloudflare Workers + Durable Objects + D1.

## Tech Stack

- TypeScript 6 (strict mode), Node.js 24
- Cloudflare Workers + Durable Objects + D1 (production and local dev via `wrangler dev`)
- ethers.js (wallet auth via EIP-191)
- Biome (formatter + linter)

## Getting Started

```sh
npm ci
npm run dev          # Wrangler dev server (local Workers runtime)
npm test             # Unit tests (domain logic)
npm run lint         # Biome check (lint + format)
```

## Type Checking

Two TypeScript configs exist because the domain tests run under Node and the Worker runs under workerd:

```sh
npm run typecheck          # Domain code + tests (tsconfig.json)
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
  worker/
    httpHandler.ts       # HTTP route handler (auth, API endpoints)
    session.ts           # EIP-191 wallet signature session management
    persistence.ts       # DO checkpoint/restore for match state
  domain/
    commitReveal.ts      # SHA-256 commit-reveal crypto
    constants.ts         # Shared constants (MIN_ESTABLISHED_MATCHES)
    questions.ts         # Question pool and selection
    settlement.ts        # Plurality settlement and payouts
  types/
    domain.ts            # Core game types
    messages.ts          # WebSocket protocol (ClientMessage / ServerMessage)
    worker-env.ts        # Cloudflare env bindings
public/                  # Static frontend (vanilla JS + ethers.js)
test/                    # Unit tests
```

Single entry point: `src/worker.ts` for both production and local dev. Domain logic in `src/domain/` is runtime-agnostic.

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
