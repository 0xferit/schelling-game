# ADR 0015: Delay public fill countdown until the first ready vote

Status: Accepted
Date: 2026-04-01

## Context

The public queue currently reserves a forming lobby as soon as at least `3` players are available, then immediately starts the `30` second fill countdown from ADR `0008`.

That behavior creates avoidable pressure:

- a newly formed lobby starts burning clock before anyone has explicitly signaled they want to launch
- small coordinated groups cannot hold a room open while they wait for one last arrival unless they leave and re-queue
- the existing ready flow already gives humans an explicit way to signal launch intent, but the countdown does not currently use it

## Decision

Public matchmaking still reserves a forming lobby immediately once it has at least `3` players, and it still starts immediately at `21` players.

The fill countdown changes as follows:

- the `30` second fill countdown remains idle when a lobby first becomes `forming`
- the countdown starts only after at least one human in that forming lobby votes ready
- if every human in the forming lobby votes ready, the match still starts immediately
- if the final ready vote is cleared because a player unvotes, leaves, or disconnects before launch, the countdown is canceled and returns to idle
- queue websocket state exposes `fillDeadlineMs = null` while the countdown is idle, and a deadline only after the countdown is armed

This ADR supersedes the automatic fill-timer arming behavior in ADR `0008` and the default-fill-window wording in ADR `0007`, while preserving the unanimous ready override.

## Consequences

- public lobbies can hold their reserved cohort indefinitely until at least one human explicitly signals readiness
- the queue UI must explain that the countdown is opt-in rather than automatic
- the ready button now serves two purposes: it arms the normal countdown and still participates in unanimous instant start
