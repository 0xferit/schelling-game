# The Schelling Game

The Schelling Game is a wallet-authenticated multiplayer coordination game built on Cloudflare Workers. Players commit answers privately, reveal them later, and try to match the answer they expect the most other players to pick. The public product now uses a literature-rooted Schelling prompt pool with both `select` and controlled `open_text` prompts. This repository contains the production Worker, the singleton Durable Object that runs the lobby and matches, D1-backed persistence, and the static frontend served at `schelling.games`.

## Live Links And Docs

- Live app: [schelling.games](https://schelling.games/)
- Next channel: [next.schelling.games](https://next.schelling.games/) (auto-deployed from `main`, manually overrideable)
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
| `npm run db:migrate:next` | Apply remote D1 migrations to the long-lived next environment. |
| `npm run smoke:staging` | Run the deployed staging smoke test. Requires `STAGING_BASE_URL`. |
| `npm run smoke:next` | Run the next smoke test against `https://next.schelling.games`. |
| `npm run deploy` | Stamp build metadata, deploy the Worker, and restore checked-in HTML files. |
| `npm run deploy:next` | Stamp build metadata, deploy the next Worker, and restore checked-in HTML files. |

CI runs:

- Biome linting
- both TypeScript configs
- domain tests with coverage
- Worker tests
- a staging deploy plus smoke validation for same-repo pull requests
- an automatic next deploy on pushes to `main`
- a manually triggered next deploy workflow for hand-picked refs

## Configuration And Secrets

Wrangler-managed bindings and default variables live in [wrangler.toml](wrangler.toml). The repo defines default (production), `staging`, and `next` environments. `next` is a long-lived release-candidate target attached to `next.schelling.games`.

| Name | Required | Source | Purpose |
| --- | --- | --- | --- |
| `DB` | Yes | `wrangler.toml` | D1 database binding for accounts, stats, auth challenges, vote/export data, and other persistent state. |
| `GAME_ROOM` | Yes | `wrangler.toml` | Durable Object namespace for the singleton `GameRoom` lobby/match coordinator. |
| `AI` | Optional | `wrangler.toml` | Workers AI binding used for open-text answer normalization. |
| `ADMIN_KEY` | Optional | Worker secret/var | Protects admin-only HTTP routes such as leaderboard eligibility and CSV export. |
| `AI_BOT_ENABLED` | Optional | `wrangler.toml` var | Enables limited AI queue backfill for undersized public queues. Bot-assisted matches stay off the record. |
| `AI_BOT_MODELS` | Optional | `wrangler.toml` var | Comma-separated Workers AI model list for backfill bot selection. Models are deduplicated, each AI-assisted match may use each model at most once, and backfill is skipped if there are not enough distinct models to reach the current target size. These models must support Workers AI structured JSON output because bot commits use a schema-constrained response. |
| `AI_BOT_TIMEOUT_MS` | Optional | `wrangler.toml` var | Timeout budget for Workers AI bot decisions. |
| `OPEN_TEXT_PROMPTS_ENABLED` | Required for public play | `wrangler.toml` var | Enables the canonical mixed prompt catalog. If disabled, public matches will not start. |
| `OPEN_TEXT_NORMALIZER_MODEL` | Optional | `wrangler.toml` var | Workers AI model used for authoritative open-text answer normalization. It must support structured JSON output. |
| `OPEN_TEXT_NORMALIZER_TIMEOUT_MS` | Optional | `wrangler.toml` var | Timeout budget for each open-text normalization attempt before the retry/backoff loop advances. |
| `TURNSTILE_SITE_KEY` | Required for interactive landing-page demo voting | `wrangler.toml` var / local `.dev.vars` | Public site key exposed through `/api/game-config` so the landing page can run Turnstile before posting demo votes. |
| `TURNSTILE_SECRET_KEY` | Required for interactive landing-page demo voting | Worker secret / local `.dev.vars` | Secret used by the Worker to validate Turnstile tokens server-side before inserting demo votes. |
| `CLOUDFLARE_API_TOKEN` | Required for remote migrations and deploys | Shell environment / CI secret | Authenticates Wrangler for staging and production operations. |
| `STAGING_BASE_URL` | Required only for `npm run smoke:staging` | Shell environment / CI | Base URL of the deployed staging Worker that the smoke script targets. |

For local manual testing of the landing-page demo vote flow, Cloudflare provides dummy Turnstile keys that work on `localhost`. Put them in `.dev.vars` instead of source control:

```sh
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

For staging/production/next, `TURNSTILE_SITE_KEY` is committed in `wrangler.toml`. Provision `TURNSTILE_SECRET_KEY` with Wrangler secrets:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --env next
```

## Deployment And CI

Before deploying to any remote environment, apply D1 migrations for that environment:

```sh
# Staging
npx wrangler d1 migrations apply DB --env staging --remote

# Next
npx wrangler d1 migrations apply DB --env next --remote

# Default/production environment
npx wrangler d1 migrations apply DB --remote
```

Staging, next, and production environment bindings are declared in [wrangler.toml](wrangler.toml).

Production deploys are manual and should be used only when you want to promote a chosen ref to `schelling.games`:

```sh
CLOUDFLARE_API_TOKEN=... npm run deploy
```

`next.schelling.games` deploys automatically on every push to `main`. You can also deploy a hand-picked branch, tag, or commit SHA to `next` manually:

```sh
CLOUDFLARE_API_TOKEN=... npm run db:migrate:next
CLOUDFLARE_API_TOKEN=... npm run deploy:next
npm run smoke:next
```

GitHub Actions automatically deploys `next.schelling.games` on every push to `main`, exposes a `Deploy next.schelling.games` workflow for manual override, and exposes a separate `Deploy schelling.games` workflow for manual production promotion.

GitHub Actions workflows currently do the following:

- pull requests to `main`: run lint, both typechecks, domain tests, and Worker tests
- eligible pull requests from the same repository: deploy to staging and run the smoke script
- pushes to `main`: apply next D1 migrations, deploy `next.schelling.games`, and run the next smoke test
- manual `workflow_dispatch`: deploy a chosen ref to `next.schelling.games` and run the next smoke test
- manual `workflow_dispatch`: deploy a chosen ref to `schelling.games`

## Background

- [Schelling Coordination in LLMs: A Review](https://www.lesswrong.com/posts/tJKNXCxx7ZKD5mtG9/schelling-coordination-in-llms-a-review)
- [Tacit Coordination of Large Language Models](https://arxiv.org/abs/2601.22184)
- [Secret Collusion among AI Agents: Multi-Agent Deception via Steganography](https://arxiv.org/abs/2402.07510)
- [Subversion via Focal Points: Investigating Collusion in LLM Monitoring](https://arxiv.org/abs/2507.03010)

Use the underlying papers rather than only secondary summaries when making concrete product or threat-model decisions.

## LLM Usage Note

This repo's optional Workers AI backfill bot is a queue-fill and availability aid, not canonical evidence about human focal points. Keep bot-influenced matches separate from prompt-pool calibration and any claims about human coordination quality.

The prompt pool should be described as a playable, literature-rooted adaptation of focal-point tasks, not as a direct replication of any single academic experiment.

## License

MIT. See [LICENSE](LICENSE).
