# ADR 0003: Anti-pre-revelation betting

Status: Superseded by ADR 0004
Date: 2026-03-23

## Context

An evidence-based leak-reporting system has two problems in this game:

- real leaks can happen off-platform, so evidence is often unavailable
- if the reward for a correct accusation is too large, blind guessing becomes positive expected value

The product needs a mechanism that:

- works regardless of leak channel
- does not require proof
- makes leaked information exploitable
- keeps uninformed guessing negative expected value

An earlier draft used a fixed side transfer. That was simpler, but it made obvious strong focal points in small matches profitable to bet on even without leaked information. That outcome was too easy to criticize as mechanism-unsound.

This decision is informed by the Ethereum Foundation discussions of anti-pre-revelation games and the P-plus-epsilon attack:

- [On Anti-Pre-Revelation Games](https://blog.ethereum.org/2015/08/28/on-anti-pre-revelation-games)
- [The P + epsilon Attack](https://blog.ethereum.org/2015/01/28/p-epsilon-attack)

## Decision

The canonical public product replaces leak reports with a private anti-pre-revelation bet phase.

Rules:

- after commit and before reveal, committed players may place one private bet per round
- each bet names a committed target and an exact guessed option
- submitting a bet burns `60`
- each bet also carries a base side-stake amount of `420`
- settlement is proportional to the guessed option's realized reveal share `P`
- if the target reveals the exact guessed option, the target pays the bettor `420 * (1 - P)`
- if the target reveals a different option, the bettor pays the target `420 * P`
- if the target does not validly reveal, the side-stake transfer is void and only the burned fee remains
- multiple bettors may independently target the same player

Here `P` is:

- `guessed_option_count / valid_reveal_count`

The constant `420` is chosen because it is divisible by every possible public-match valid reveal count from `1` to `7`, preserving integer-only balance accounting.

## Consequences

- The mechanism is channel-agnostic: it works whether information leaked in game chat, in a private message, or elsewhere.
- Against an average target, the side-stake component is zero expected value before fees, so the burned `60` makes uninformed betting negative expected value.
- Correct private information can be profitably exploited without needing proof.
- A correct bet is not proof that the target leaked; it can also result from public inference.
- The proportional settlement rule is taken directly from the anti-pre-revelation oracle design in the referenced Ethereum article, rather than the simpler fixed-transfer variant.
- Public focal-point strength alone should no longer create a systematic betting edge against an average target.
- Target-specific information or persistent answer habits can still be exploited, which is the intended function of the mechanism.
- The mechanism still introduces bounded second-order grief risk, so bet frequency and targeting patterns should be monitored in telemetry.
- Successful anti-pre-revelation bets do not void the round; they are a separate side settlement.
- The public protocol gains a dedicated bet phase and a new persistent bet log.
