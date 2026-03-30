# ADR 0012: Decouple prompt catalog size from match length

Status: Accepted
Date: 2026-03-30

Supersession note: This ADR supersedes ADR [0010](0010-ten-seed-ai-normalized-public-mode.md).

## Context

ADR 0010 established a fixed 10-prompt seed catalog where every public match uses all 10 prompts exactly once. This hard-coupled catalog size, match length, and prompt selection: the validator rejected pools that were not exactly 10 prompts, `selectPromptsForMatch` required `count === catalog.length`, and the ID range was hardcoded to 1001-1010.

To grow the catalog toward 50 prompts (staged: 10, 20, 35, 50) while keeping matches at 10 games, the catalog size must be decoupled from the match length.

A secondary gap: `canonicalExamples` on open-text prompts were consumed by AI bot generation and normalization prompts but never validated at catalog definition time.

## Decision

Catalog size is decoupled from match length via balanced sampling:

- `MATCH_GAME_COUNT` (currently `10`) remains the sole authority on games per match.
- `selectPromptsForMatch(count)` samples `floor(count/2)` select prompts and `count - floor(count/2)` open-text prompts from the catalog, then shuffles the combined sample.
- Validators use minimums instead of exact counts: the catalog must contain at least `MATCH_GAME_COUNT` prompts with at least `ceil(MATCH_GAME_COUNT/2)` of each type.
- Prompt IDs must be unique and positive but no longer require a contiguous range.
- `canonicalExamples` on open-text prompts are validated at catalog definition time against both `validateAnswerText` and `canonicalizeOpenTextAnswer`.

All other aspects of ADR 0010 remain in effect: Workers AI normalization is authoritative, the four-step open-text flow is preserved, and phase timings are unchanged.

## Consequences

- The catalog can grow beyond 10 prompts without changing match format.
- Each match samples a balanced subset from the catalog; players see different prompt combinations across matches.
- New prompts need a unique positive ID and a unique `PromptRoot` but not a contiguous ID range.
- Invalid `canonicalExamples` are caught at catalog validation time, before they can bias AI behavior at runtime.
- The staged expansion path (10, 20, 35, 50) can proceed with prompt-only changes; no further infrastructure work is needed.
