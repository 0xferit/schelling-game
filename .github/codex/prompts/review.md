Review this pull request against its base branch.

Focus on:
- bugs and behavioral regressions
- auth, session, or security issues
- Worker, Durable Object, and reconnect/persistence edge cases
- protocol mismatches between the worker, frontend, and tests
- missing or insufficient test coverage when behavior changes

Ignore style-only feedback unless it hides a bug.
Do not praise the PR.
Only report actionable findings.

If there are no actionable findings, say exactly:
No actionable findings.

When you report a finding:
1. Start with `[P1]`, `[P2]`, or `[P3]`.
2. Include the file path and line number when you can determine them.
3. Use one short paragraph that explains the problem, the user-visible impact, and any testing gap that matters.

Keep the response concise and high signal.
