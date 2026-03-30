## Summary

Describe the change at a high level.

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck:worker`
- [ ] `npm test`
- [ ] `npm run test:worker`

## Preview

This repo uses a shared Cloudflare staging deployment instead of isolated per-PR preview environments.

- Same-repo PRs: CI posts or updates a sticky `Preview Guide` comment with the latest staging URL after required checks pass.
- Fork PRs: automatic staging deploys do not run. Use the local preview flow below or ask a maintainer to deploy staging manually.

Local preview:

```sh
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev
```

Staging preview:

- Wait for the `Staging deploy + smoke` job in CI.
- Open the staging URL from the sticky PR comment.
- Remember that staging is shared, so newer PR runs can replace the deployed build.
