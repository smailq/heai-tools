# Releasing a tool

Each tool is released on its own, from a GitHub release whose tag names the tool and the version: `<tool>-v<version>`.
The tool's directory name is the tool's name; the command it installs is `heai-<tool>`.

| tool | tag | artifact | package |
|---|---|---|---|
| `architect`, `flow`, `pod`, `reactor`, `tasks` | `tasks-v0.2.0` | the npm tarball on the release | `@heai-tools/<tool>` on npm, once enabled |
| `operator` | `operator-v0.1.0` | `heai-operator` for linux and darwin, amd64 and arm64, with checksums | none; `go install` also works |

`map-editor` is not released.

## Cutting a release

1. For a Node tool, set the new version in `tools/<tool>/package.json` and commit; the workflow refuses a tag whose version differs from the manifest's.
2. Publish a GitHub release on that commit, tagged `<tool>-v<version>`:

   ```sh
   gh release create tasks-v0.2.0 --title "tasks 0.2.0" --generate-notes
   gh release create operator-v0.1.0 --title "operator 0.1.0" --generate-notes
   ```

3. [`release.yml`](../.github/workflows/release.yml) runs on the published release: it typechecks and tests the tool, builds it, attaches the artifact to the release, and, when npm publishing is turned on, publishes the Node tool to npm with provenance.

A release for a tool the workflow does not know, or a tag that is not `<tool>-v<semver>`, fails at the first job with the reason.

## What a Node tool ships

`npm install` (and so `npm ci`, `npm link` and `npm publish`) runs `prepare`, which compiles `src/` to `dist/` with `tsconfig.build.json`.
The package's `bin` and `exports` point at `dist/`; `files` limits the tarball to `dist/`, `schemas/` and, for `pod`, `image/`.
`npm pack --dry-run` from the tool's directory lists exactly what a release would publish.

Sources are compiled rather than shipped as TypeScript because Node does not strip types from files under `node_modules`, which is where an installed package lives.

## Turning on npm

Publishing is off until the registry side exists, so a GitHub release works today and npm is one switch away.

1. Create the `heai-tools` organization on npmjs.com, or make sure the `@heai-tools` scope is yours.
2. The first publish of each package cannot use trusted publishing, because a trusted publisher is configured on a package that already exists. Either publish the first version from a laptop (`npm login`, then `npm publish` from the tool's directory), or add a repository secret `NPM_TOKEN` holding a granular access token with publish rights on the scope.
3. Set the repository variable `NPM_PUBLISH` to `true`. From then on the release workflow publishes.
4. Once every package exists, configure a trusted publisher on each one at npmjs.com (repository `smailq/heai-tools`, workflow `release.yml`, no environment) and delete `NPM_TOKEN`; the workflow falls back to OIDC when the secret is absent.

The workflow always passes `--provenance`, so every published version carries a signed link back to the commit and run that built it.

## Installing a released tool

```sh
npm install -g @heai-tools/tasks        # puts heai-tasks on PATH
go install github.com/smailq/heai-tools/tools/operator/cmd/heai-operator@latest
```

`operator` shells out to `heai-architect`, `heai-flow`, `heai-pod`, `heai-reactor` and `heai-tasks` by those names, so they must be on PATH for their panes and actions to work.
