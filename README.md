# schelling-game

Prototype commit-reveal coordination game.

The canonical game rules and design live in [docs/game-design.md](docs/game-design.md). It describes the game's core logic, match flow, commit-reveal rules, settlement, coordination credit, and question design policy.

Architectural rationale is logged in [docs/adr/README.md](docs/adr/README.md).

## Further Reading

- [Schelling Coordination in LLMs: A Review](https://www.lesswrong.com/posts/tJKNXCxx7ZKD5mtG9/schelling-coordination-in-llms-a-review) for a useful survey of toy-task coordination, covert-channel risk, and why deployment context matters more than isolated coordination scores.
- [Secret Collusion among AI Agents: Multi-Agent Deception via Steganography](https://arxiv.org/abs/2402.07510) for the underlying steganography and covert-collusion evaluation framework cited by the review.
- [Subversion via Focal Points: Investigating Collusion in LLM Monitoring](https://arxiv.org/abs/2507.03010) for a more deployment-shaped evaluation of focal-point collusion in monitoring setups.

Use the underlying papers, not only the LessWrong summary, when making concrete product or threat-model decisions.

## LLM Usage Note

This repo's optional Workers AI backfill bot is a queue-fill/testing aid, not canonical evidence about human focal points. Keep bot-influenced matches separate from question-pool calibration and any claims about human coordination quality.
