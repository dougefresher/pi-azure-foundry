# Changesets

Version + changelog management for this repo. Upstream docs:
https://github.com/changesets/changesets

## Workflow

    npm run changeset            # describe a change (patch/minor/major + summary)
    npm run changeset -- --empty # tooling-only change, no release needed
    npm run changeset:version    # consume changesets, bump package.json, write CHANGELOG.md

`changeset status` exits non-zero when the working tree has changes but no
changeset — that is the hook the Buildkite pipeline gates on.

## Local conventions

- `CHANGELOG.md` is generated. Its first line must stay a single-line `# <pkg>`
  heading: changesets prepends each new entry immediately after the first
  newline, so any preamble added there gets pushed below the latest release.
- History through v1.1.0 is frozen in `CHANGELOG-FROM-FORK.md` (Keep a Changelog
  format, hand-maintained, inherited from the fork). Do not append to it.
- No `version` or `release` script on purpose. npm runs a script literally named
  `version` as a lifecycle hook during `npm version`, which would fire
  `changeset version` mid-bump. The scripts are `changeset:*` instead.
- Publishing to npm is not part of the flow, so there is no `changeset publish`
  wired up. `access: "public"` in the config is only there to keep it from
  contradicting `publishConfig` if that ever changes.
