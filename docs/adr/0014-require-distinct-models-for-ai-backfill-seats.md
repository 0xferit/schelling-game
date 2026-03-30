# ADR 0014: Require distinct models for AI backfill seats

Status: Accepted
Date: 2026-03-30

Supersession note: This ADR supersedes ADR [0013](0013-raise-ai-backfill-target-to-five-players.md)'s implicit permission to reuse the same model across multiple synthetic seats in one AI-assisted public match. The rest of ADR `0013` remains canonical.

## Context

ADR `0013` raised AI-assisted backfill targets to `5` total players, but the runtime still assigned bot seats by cycling through `AI_BOT_MODELS`. With a short model list, the same model could appear multiple times in the same match.

That weakens the intended diversity of synthetic seats:

- repeated model seats are more correlated than distinct-model seats
- a five-seat backfilled match should not be simulated by cloning the same model multiple times
- the product can already wait for more humans instead of forcing a low-diversity synthetic lobby

## Decision

AI-assisted public matches now require distinct bot models per synthetic seat:

- `AI_BOT_MODELS` is treated as a deduplicated ordered set
- one configured model may be used at most once in a single AI-assisted public match
- if the current undersized queue would need more bot seats than there are distinct configured models, no AI backfill is added for that cohort yet
- as more humans join, the required bot-seat count drops and the queue may become eligible for AI backfill later

The five-seat backfill target from ADR `0013` remains in effect whenever enough distinct models are available.

## Consequences

- AI-assisted matches have more diverse synthetic seats and avoid same-model duplication
- deployments that want solo-to-five or duo-to-five AI backfill must configure at least `4` or `3` distinct models respectively
- with shorter model lists, very small queues will wait for more humans instead of launching a lower-diversity AI-assisted match
- tests and configuration docs must describe `AI_BOT_MODELS` as a distinct-model pool rather than a cyclic list
