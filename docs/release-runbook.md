# Release runbook: `@webergency-utils/ai`

First publish is `0.1.0`. Nothing here is automated end to end on purpose: a maintainer runs a dry run, reads the log, then publishes.

## One-time setup (owner)

1. **npm ownership.** Make sure the `@webergency-utils` npm organization exists and you can publish public scoped packages to it (`npm access list packages @webergency-utils`).
2. **Authentication for `publish.yml`.** Either:
   - configure an npm *trusted publisher* for this repository and the `publish.yml` workflow (preferred; no secret), or
   - create a granular automation token and add it as the `NPM_TOKEN` secret of the `npm` environment, then add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the Publish step's `env`.
3. **`npm` GitHub environment.** Settings → Environments → `npm`: require a reviewer and restrict deployment branches/tags to `main` and `v*`.
4. **Branch protection on `main`** requiring the CI jobs: Quality gates, Test (all matrix entries), Coverage, Bun smoke, actionlint.
5. **Optional recordings.** To replace synthetic fixtures with real captures, run `npm run record:fixtures` locally with provider keys and commit the result after review.

## Before every release

```bash
git switch main && git pull
npm ci
npm run release:check         # lint, typecheck, build, coverage, check:pack, smoke:pack, publint, attw, README checks
npm pack --dry-run            # review the file list: dist, src, README, LICENSE, SECURITY, CHANGELOG only
```

1. Move the `## [Unreleased]` entries in `CHANGELOG.md` under the new version with the release date, and update the compare links.
2. Set `package.json` `version` (`npm version <x.y.z> --no-git-tag-version`), commit, merge to `main`.

## Dry run (always first)

GitHub → Actions → **Publish** → *Run workflow* on `main` with `dry_run` left **true** (leave `tag` empty, or enter `vX.Y.Z` to check the guard). The workflow runs lint, typecheck, build, coverage, the tarball smoke test, `publint`/`attw`, the version/tag guard, then `npm publish --dry-run --provenance`. Read the log: the file list and package size must match `npm pack --dry-run`, and there must be no warnings.

## Publish

1. Create and push the tag from the release commit on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
2. Create a GitHub release for that tag and publish it. `release: published` triggers `publish.yml` with a real publish. The guard fails the run before `npm publish` when the tag differs from `package.json` `version` or the tagged commit is not reachable from `main`.
   Alternatively run the workflow manually with `dry_run` **false** and `tag` set to `vX.Y.Z`; the same guard applies.
3. Approve the deployment on the `npm` environment when prompted.

## After publishing

- `npm view @webergency-utils/ai version dist.tarball` shows the new version; the package page shows the **Provenance** badge.
- In a scratch directory: `npm i @webergency-utils/ai`, then import every subpath (`scripts/fixtures/smoke-imports.mjs` is the reference list).
- Start a fresh `## [Unreleased]` section in the changelog.

## If something goes wrong

- A published version cannot be replaced. Deprecate it (`npm deprecate @webergency-utils/ai@x.y.z "reason"`) and publish a patch.
- Guard failure: fix the version/tag mismatch and re-run; nothing was published.
- Provenance failure: confirm `id-token: write` on the job, a GitHub-hosted runner, and that npm `>=9.5` is active (the workflow pins `npm@11`).
