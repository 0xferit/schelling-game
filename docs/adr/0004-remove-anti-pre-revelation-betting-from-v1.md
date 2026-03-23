# ADR 0004: Remove anti-pre-revelation betting from v1

Status: Accepted
Date: 2026-03-23

## Context

The team explored anti-pre-revelation betting in two versions:

- a simple fixed-transfer design,
- then a proportional settlement design inspired by the Ethereum Foundation anti-pre-revelation writeup.

The proportional version fixed one real weakness of the fixed-transfer draft: obvious focal points were no longer profitable to bet on for a lone price-taking bettor against an average target.

However, later review surfaced two remaining problems that were too serious for the public v1 product:

- coalitions of players can manipulate the realized option share and restore positive expected value for targeted bets,
- multiple bettors can stack exposure onto one target, creating outsized side losses unrelated to the round pot.

These issues make the mechanic too easy to describe as strategically unsound in small public matches.

## Decision

The canonical public product removes anti-pre-revelation betting from v1.

V1 therefore has:

- no player-side leak-reporting mechanic,
- no side-betting phase between commit and reveal,
- no in-protocol economic settlement for leaked information.

Leak concerns in v1 are handled operationally instead:

- commit-reveal still prevents straightforward in-round copying,
- matchmaking and anti-repeat rules reduce repeated small-group pairing,
- ordinary service moderation and anti-abuse controls remain available.

## Consequences

- The public protocol is simpler and easier to defend.
- The game no longer claims an in-match cryptoeconomic response to leaked information.
- Reviewers should evaluate the product as an offchain coordination game, not as a trustless anti-collusion oracle.
- Anti-pre-revelation betting can be revisited only with a stronger design that addresses coalition manipulation and aggregate target exposure.
