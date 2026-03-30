# ADR 0010: Ten-seed AI-normalized public mode

Status: Accepted
Date: 2026-03-30

Supersession note: This ADR supersedes ADR [0009](0009-hybrid-prompt-public-mode.md).

## Context

ADR 0009 expanded the public game into a 100-prompt hybrid catalog with root-balanced sampling and conservative open-text fallback. That solved some fragmentation problems, but it also introduced more catalog management, more documentation surface area, and a degraded open-text path whenever Workers AI was unavailable.

The current product direction is narrower: public matches should always run the same canonical 10-game seed set, and open-text settlement should stay coherent by treating Workers AI normalization as authoritative rather than optional.

## Decision

The canonical public mode now uses a fixed 10-prompt seed catalog:

- `5` `select` prompts:
  - `Pick a side of a coin.`
  - `Pick a fruit.`
  - `Pick a colour.`
  - `Pick a day of the week.`
  - `Pick a planet.`
- `5` `open_text` prompts:
  - `Pick a number between 1 and 10.`
  - `Pick a playing card.`
  - `Split $100 with a stranger. How much do you keep?`
  - `Pick a city.`
  - `Pick a word.`

Every public human match uses all 10 prompts exactly once in shuffled order.

`open_text` prompts now require:

1. deterministic transport normalization
2. prompt-aware canonicalization for commit/reveal verification
3. Workers AI bucket assignment for settlement

Workers AI normalization is authoritative. If the normalization run is unavailable, times out, or returns invalid schema, the game enters a retry loop with `2s`, `5s`, and `10s` backoff. If all retries fail, that game is voided. Exact-match fallback is removed.

The public client and worker both expose an explicit `normalizing` phase for open-text games.

AI-assisted public matches and select-only public matches are disabled for this catalog.

## Consequences

- The public product becomes easier to reason about: one fixed 10-game seed set, shuffled order only.
- Open-text commitment verification is now prompt-aware instead of using one generic normalized string path.
- Open-text settlement coherence improves because semantically equivalent answers are merged by authoritative AI normalization instead of splitting on syntax.
- Public match start now requires `OPEN_TEXT_PROMPTS_ENABLED`; when disabled, queued players are restored to the lobby instead of starting a degraded match format.
- Documentation, marketing copy, and tests must describe a four-step open-text flow: commit, reveal, normalizing, results.
