# ADR 0001: Select-only plurality public mode

Status: Accepted
Date: 2026-03-23

Supersession note: ADR [0006](0006-generalize-public-match-sizes.md) and ADR [0008](0008-remove-public-odd-match-requirement.md) supersede this ADR's original public-match-size restriction and odd-lobby rationale. The rest of this ADR remains canonical.

## Context

The earlier public spec mixed two different ideas:

- a Schelling-style focal-point game built around discrete, salient choices
- a continuous coordination game scored by distance from a mean

That mismatch was strongest for `select` questions. Exact focal-point convergence is about whether players independently chose the same option, not whether their encoded option indexes clustered around an average.

The earlier design also canceled high-agreement rounds via a low-sigma rule, which discarded the strongest evidence of independent convergence.

## Decision

The canonical public mode uses:

- `select` questions only
- exact-match plurality scoring
- no mean, sigma, or distance-from-average coherence rule
- no cancellation for strong convergence
- a round void only when zero valid reveals exist
- odd public match sizes only: 3, 5, and 7
- a fixed 10-round public match format

Under plurality scoring:

- players on the top-count option set are coherent
- tied top options all count as winning options
- a single valid revealer can win the whole round pot

## Consequences

- Slider questions are non-canonical for the public mode.
- Question design shifts toward discrete focal alternatives instead of numeric scales.
- Matchmaking must preserve odd player counts because plurality scoring behaves better with odd committees.
- Perfect convergence is no longer canceled, but it is also not extra-rewarded: unanimous rounds are economically neutral because everyone simply gets their own ante back.
- The current prototype's mean-and-sigma implementation is now explicitly out of spec.
