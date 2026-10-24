# Releasing

This page is for the maintainer. A release is made by pushing a version tag. The `Release` workflow (`.github/workflows/release.yml`) does the rest.

## What the workflow does

When a tag `vX.Y.Z` is pushed, the workflow:

1. checks out the tagged commit and checks that the tag matches the `version` in `package.json`, that the commit is on `main`, and that [CHANGELOG.md](../CHANGELOG.md) has a section for the version. It stops if any of these is false, before anything is published;
2. runs the verification: lint, type check and the tests. It then packs the tarball once, runs the package check on that very file, and records its SHA-256 sum;
3. publishes that tarball with `npm publish --provenance`, using npm trusted publishing (OpenID Connect) from the GitHub environment `npm`, so that no npm token is stored anywhere. A version that is already on npm is not published again;
4. creates a GitHub release for the tag, unless one exists already, with the CHANGELOG section as its notes. When step 3 published the tarball, the release also has it attached, with its sum. A version with a hyphen, such as `0.2.0-rc.1`, is published under the npm dist-tag `next`, so that `npm install durable-lens` does not pick it up, and its GitHub release is marked as a pre-release.

The publish job stops unless npm is 11.5.1 or newer, which trusted publishing requires. The npm package page then shows the provenance: the repository, the commit and the workflow that built it. The first version is published by hand and has no provenance; every version from the second on has it.

## One-time setup

Do this once, before the first tagged release.

1. **GitHub environment.** In the repository settings, under Environments, create an environment named `npm`. If you want a manual gate on every publish, add yourself as a required reviewer.
2. **First publish, by hand.** Trusted publishing can only be configured for a package that already exists on npm, so the first version is published manually:
   1. Check out a clean copy of the commit to release, and run `npm ci` and `npm run verify`.
   2. Log in with `npm login`, with two-factor authentication on.
   3. Run `npm publish --access public`. A version with a hyphen needs `--tag next` as well.
   4. Check the package on npmjs.com, and try `npx durable-lens --version` in an empty directory.
3. **Trusted publisher.** On npmjs.com, open the package, then Settings, then Trusted Publisher, choose GitHub Actions, and enter:
   - organization or user: `dggc`
   - repository: `durable-lens`
   - workflow filename: `release.yml`
   - environment name: `npm`
4. After this, remove any npm token you created for the manual publish, and consider setting the package to require two-factor authentication and disallow tokens.

For the first version (0.1.0), published by hand, push the tag `v0.1.0` afterwards (`git tag v0.1.0 && git push origin v0.1.0`). The workflow verifies the commit, sees that 0.1.0 is already on npm and does not publish it, and creates the GitHub release with the CHANGELOG notes but no tarball, since the one it built is not byte for byte the one you published. Every later version goes through the workflow from start to end.

## Making a release

1. Make sure `main` is green and holds everything for the release.
2. Choose the version, following [Semantic Versioning](https://semver.org/). Before 1.0, a new feature or a change to the JSON output raises the minor number, and a fix raises the patch number.
3. Update the changelog in [CHANGELOG.md](../CHANGELOG.md):
   - rename the heading of the version to `## [X.Y.Z] - YYYY-MM-DD` (the workflow finds the section by the number in the heading), moving what is under `## [Unreleased]` into it;
   - leave an empty `## [Unreleased]` above it;
   - update the links at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD`, and `[X.Y.Z]` compares the previous tag with `vX.Y.Z`. Until the first tag exists, `[Unreleased]` and `[0.1.0]` point at `commits/main`; for 0.1.0, link to the tag `v0.1.0` once it exists.
4. Set the version in `package.json` and the lock file, without creating a tag yet:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

5. Run `npm run verify`. For a release that changes the page, also run `CHROME_BIN=/path/to/chrome npm run check:ui`.
6. Commit with a message such as `Release X.Y.Z`, and push it to `main`. Wait for the CI.
7. Tag that commit, which must be on `main`, and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "X.Y.Z"
   git push origin vX.Y.Z
   ```

8. Watch the `Release` run. When it succeeds, check that the version is on npm with its provenance, and that the GitHub release has the right notes.

## If a release fails

- **The check that the tag matches `package.json` fails.** Delete the tag locally and on the remote, fix `package.json`, and tag again. Do this only before anything was published.
- **Verification fails.** Fix it on `main`, and move to a new patch version. Do not reuse a tag that was pushed.
- **The publish failed after the check.** Read the log. A trusted publisher that does not match (a typo in the workflow filename or the environment name) is the usual cause. Fix the setting on npmjs.com and run the workflow again from the Actions page.
- **A bad version was published.** npm does not allow replacing a version. Publish a fixed one, and use `npm deprecate durable-lens@X.Y.Z "reason"` on the bad one. Unpublishing is a last resort and has npm's time limits.
