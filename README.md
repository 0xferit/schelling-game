# The Schelling Game

The Schelling Game is a wallet-authenticated multiplayer coordination game built on Cloudflare Workers. Players commit answers privately, reveal them later, and try to match the answer they expect the most other players to pick. The public product now uses a literature-rooted Schelling prompt pool with both `select` and controlled `open_text` prompts. This repository contains the production Worker, the singleton Durable Object that runs the lobby and matches, D1-backed persistence, and the static frontend served at `schelling.games`.

## Live Links And Docs

- Live app: [schelling.games](https://schelling.games/)
- Canonical game rules: [docs/game-design.md](docs/game-design.md)
- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)

`docs/game-design.md` is the authoritative rules document. Keep gameplay rule changes there instead of re-documenting them in this README.

## Product Summary

- Browser-based multiplayer coordination game with commit/reveal gameplay and exact-match plurality settlement.
- Wallet login uses signed EIP-191 challenge messages. Sessions, balances, and match state live in the application backend rather than onchain.
- Progression uses an internal token balance plus a moderated public leaderboard.
- Optional Workers AI backfill can help fill public queues for testing and availability. Bot-assisted matches are off the record and do not affect balances, streaks, or leaderboard standing.

## Architecture Overview

- `public/` contains the static landing page, app shell, and shared frontend assets served by Workers Assets.
- `src/worker.ts` is the Worker entrypoint and defines the singleton `GameRoom` Durable Object that manages queueing, match formation, reconnects, and match settlement orchestration.
- `src/worker/httpHandler.ts` handles HTTP routes for auth, profile updates, leaderboard reads, exports, admin actions, and game config. WebSocket gameplay connects through `/ws` and is delegated into `GameRoom`.
- `src/domain/` contains runtime-agnostic game logic such as commit/reveal validation, prompt selection, and settlement.
- `d1-migrations/` contains the D1 schema and schema changes for accounts, player stats, auth challenges, vote logs, example votes, and related data.
- `test/domain/` covers pure domain logic under Node/Vitest. `test/worker/` covers Worker, Durable Object, D1, and HTTP behavior with Cloudflare's Vitest worker pool.

## Repo Layout

```text
.
├── public/                 # Static frontend and landing pages
├── d1-migrations/          # D1 schema and migrations
├── docs/
│   ├── game-design.md      # Canonical gameplay rules
│   └── adr/                # Architecture decision records
├── src/
│   ├── domain/             # Runtime-agnostic game logic
│   ├── types/              # Shared TypeScript types
│   ├── worker/             # HTTP/session/persistence helpers
│   └── worker.ts           # Worker entrypoint + GameRoom Durable Object
├── test/
│   ├── domain/             # Domain tests
│   └── worker/             # Worker/DO/D1 route tests
├── package.json
└── wrangler.toml
```

## Prerequisites

- Node.js `24`
- `npm`
- Cloudflare Wrangler access for D1 migrations and deploys
- An Ethereum-compatible browser wallet if you want to exercise the live UI manually

Install dependencies with:

```sh
npm ci
```

## Local Development

Apply local D1 migrations, then start the Worker runtime:

```sh
npx wrangler d1 migrations apply DB --local
npm run dev
```

`npm run dev` starts `wrangler dev`, which serves the static frontend from `public/`, the HTTP API, and the WebSocket game endpoint from a local Workers runtime.

If you change D1 schema, re-apply the local migrations before restarting or re-testing flows that depend on the new schema.

## Test And Quality Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run domain tests in `test/domain/`. |
| `npm run test:worker` | Run Worker, Durable Object, D1, and HTTP tests in `test/worker/`. |
| `npm run typecheck` | Type-check the Node-side domain/test code with `tsconfig.json`. |
| `npm run typecheck:worker` | Type-check Worker code with `tsconfig.worker.json`. |
| `npm run lint` | Run Biome checks across the repo. |
| `npm run smoke:staging` | Run the deployed staging smoke test. Requires `STAGING_BASE_URL`. |
| `npm run deploy` | Stamp build metadata, deploy the Worker, and restore checked-in HTML files. |

CI runs:

- Biome linting
- both TypeScript configs
- domain tests with coverage
- Worker tests
- a staging deploy plus smoke validation for same-repo pull requests

## Configuration And Secrets

Wrangler-managed bindings and default variables live in [wrangler.toml](wrangler.toml). The repo defines both default and `staging` environments.

| Name | Required | Source | Purpose |
| --- | --- | --- | --- |
| `DB` | Yes | `wrangler.toml` | D1 database binding for accounts, stats, auth challenges, vote/export data, and other persistent state. |
| `GAME_ROOM` | Yes | `wrangler.toml` | Durable Object namespace for the singleton `GameRoom` lobby/match coordinator. |
| `AI` | Optional | `wrangler.toml` | Workers AI binding used for open-text answer normalization. |
| `ADMIN_KEY` | Optional | Worker secret/var | Protects admin-only HTTP routes such as leaderboard eligibility and CSV export. |
| `AI_BOT_ENABLED` | Optional | `wrangler.toml` var | Legacy flag for AI queue backfill. Public mixed-mode matches now disable bot backfill even if this is enabled. |
| `AI_BOT_MODELS` | Optional | `wrangler.toml` var | Comma-separated Workers AI model list for backfill bot selection. |
| `AI_BOT_TIMEOUT_MS` | Optional | `wrangler.toml` var | Timeout budget for Workers AI bot decisions. |
| `OPEN_TEXT_PROMPTS_ENABLED` | Required for public play | `wrangler.toml` var | Enables the canonical mixed prompt catalog. If disabled, public matches will not start. |
| `CLOUDFLARE_API_TOKEN` | Required for remote migrations and deploys | Shell environment / CI secret | Authenticates Wrangler for staging and production operations. |
| `STAGING_BASE_URL` | Required only for `npm run smoke:staging` | Shell environment / CI | Base URL of the deployed staging Worker that the smoke script targets. |

## Deployment And CI

Before deploying to any remote environment, apply D1 migrations for that environment:

```sh
# Staging
npx wrangler d1 migrations apply DB --env staging --remote

# Default/production environment
npx wrangler d1 migrations apply DB --remote
```

Staging and production environment bindings are declared in [wrangler.toml](wrangler.toml). Production deploys use:

```sh
CLOUDFLARE_API_TOKEN=... npm run deploy
```

GitHub Actions workflows currently do the following:

- pull requests to `main`: run lint, both typechecks, domain tests, and Worker tests
- eligible pull requests from the same repository: deploy to staging and run the smoke script
- pushes to `main`: apply production D1 migrations and deploy the Worker

## Background

- [Schelling Coordination in LLMs: A Review](https://www.lesswrong.com/posts/tJKNXCxx7ZKD5mtG9/schelling-coordination-in-llms-a-review)
- [Secret Collusion among AI Agents: Multi-Agent Deception via Steganography](https://arxiv.org/abs/2402.07510)
- [Subversion via Focal Points: Investigating Collusion in LLM Monitoring](https://arxiv.org/abs/2507.03010)

Use the underlying papers rather than only secondary summaries when making concrete product or threat-model decisions.

## LLM Usage Note

This repo's optional Workers AI backfill bot is a queue-fill and availability aid, not canonical evidence about human focal points. Keep bot-influenced matches separate from prompt-pool calibration and any claims about human coordination quality.

The prompt pool should be described as a playable, literature-rooted adaptation of focal-point tasks, not as a direct replication of any single academic experiment.

## License

MIT. See [LICENSE](LICENSE).
