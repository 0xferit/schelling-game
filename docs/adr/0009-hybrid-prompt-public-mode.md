# ADR 0009: Hybrid prompt public mode

Status: Accepted
Date: 2026-03-29

Supersession note: This ADR supersedes the `select`-only portion of ADR [0001](0001-select-only-plurality-public-mode.md). Exact-match plurality and the fixed 10-game public format remain canonical.

## Context

The public game originally restricted itself to `select` prompts only. That kept settlement simple, but it also forced some classic focal-point families into brittle multiple-choice lists where the focal answer was fragmented across overlapping options.

For launch, the prompt pool also needed to become larger, less repetitive, and more defensibly rooted in published focal-point families rather than ad hoc product copy.

## Decision

The canonical public mode now uses a hybrid prompt pool:

- `100` literature-rooted prompt adaptations
- `80` `select` prompts
- `20` `open_text` prompts

Public match selection stays fixed at `10` games, but prompt selection is root-balanced:

- at least `8` distinct prompt families per match
- at most `2` `open_text` prompts per match
- no semantic family may appear in both `select` and `open_text` form in the same match
- contextualized roots appear at most once per match
- at most one calibration prompt per match

`open_text` prompts use two-stage normalization:

1. deterministic transport normalization for commit/reveal verification
2. conservative post-reveal bucket assignment for settlement

Bucket assignment uses Workers AI when available and falls back to exact-match plurality on deterministically normalized text when the AI normalizer is unavailable or invalid. The normalization run and verdicts are persisted for replay and audit.

AI-assisted matches remain `select`-only for now.

## Consequences

- The public mode is no longer strictly `select`-only.
- Commit/reveal now supports both option-index and answer-text reveals.
- Settlement remains plurality-based, but the counted unit becomes either an option identity or a canonical answer bucket depending on prompt type.
- Prompt-pool quality depends more heavily on conservative normalization and auditable persistence artifacts.
- Marketing and documentation should describe the pool as a playable, literature-rooted adaptation of focal-point theory rather than a direct replication of any one experiment.
