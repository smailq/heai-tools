# @heai-tools/scope-gate

Checks a diff against the architecture map's ownership boundaries.
The diff arrives on stdin, the subject is named on the command line, and the exit code is the answer.

```sh
git diff origin/main... | node src/cli.ts --territory api
echo $?   # 0 clean, 1 boundary violation, 2 bad usage or unreadable map
```

Requires Node 22.18 or newer, which runs the TypeScript sources directly.
`npm install` pulls one runtime dependency, a YAML parser.

## Usage

```
scope-gate <name> [options]
scope-gate --territory <name> [options]
scope-gate --actor <name> [options]
```

The diff is read from **stdin**; the subject is named on the command line; the exit code is the answer.
Run it as `node src/cli.ts ...` from the tool directory, or install the package and use the `scope-gate` bin.

### Subject

Exactly one, and required.
A bare positional name is resolved against both namespaces and must be qualified if it is both a territory and an actor.
Giving a positional name together with `--territory` or `--actor` is an error rather than a silent choice between them.

| option | argument | what it allows |
| --- | --- | --- |
| `--territory` | territory name | that one territory's paths |
| `--actor` | actor name | every territory that actor owns |
| *(positional)* | either | resolved against both namespaces |

### Options

| option | argument | default | meaning |
| --- | --- | --- | --- |
| `--map` | path | `architecture.yaml` | the architecture map to read |
| `--repo` | repository name | the only one, if the map declares one | which repository the diff came from |
| `--format` | `text` or `json` | `text` | output format |
| `--all` | - | off | list every changed file, not only findings |
| `--help` | - | - | print usage and exit 0 |

### Exit codes

| code | meaning |
| --- | --- |
| `0` | every changed path is allowed |
| `1` | at least one boundary violation |
| `2` | bad usage, unreadable map, or invalid map |

Exit `2` covers anything that makes the question unanswerable rather than answered "no": an unknown subject, a subject named twice, an unknown `--format`, a missing or unparseable map, a map whose `version` is not `1`, a glob the dialect rejects, and a path claimed by two territories.

### Examples

```sh
# What an agent's branch changed, against the territory it declared.
git diff origin/main... | node src/cli.ts --territory api

# Include untracked files: git diff does not report them until they are marked.
git add -AN && git diff HEAD | node src/cli.ts --territory api

# An actor working across every territory it owns.
git diff origin/main... | node src/cli.ts --actor api-owner

# A map governing several repositories needs to be told which one.
git diff origin/main... | node src/cli.ts --territory api --repo app

# In CI, with the result as JSON.
git diff --name-only origin/main... \
  | node src/cli.ts --territory "$TERRITORY" --format json > scope.json
```

### JSON output

`--format json` prints one object, whatever the verdict.
`findings` carries every changed path, in path order, whether or not it failed; `--all` affects only the text format.

```json
{
  "ok": false,
  "repository": "app",
  "subject": { "kind": "territory", "name": "api", "territories": ["api"], "owner": "api-owner" },
  "unownedPosture": "fail",
  "changedFiles": 3,
  "violations": 1,
  "findings": [
    {
      "path": "ci/x.yml",
      "classification": "foreign",
      "territory": "platform",
      "owner": "smailq",
      "ownerType": "human",
      "fatal": true
    }
  ]
}
```

| field | meaning |
| --- | --- |
| `ok` | true when nothing failed; matches exit code `0` |
| `repository` | the repository the diff was checked against |
| `subject` | what was named, and the territories it may change |
| `unownedPosture` | the posture in force for this repository, `fail` or `allow` |
| `changedFiles` | how many paths the diff yielded |
| `violations` | how many findings are `fatal` |
| `findings[].classification` | `owned`, `foreign`, or `unowned` |
| `findings[].territory` | the owning territory, or `null` when unowned |
| `findings[].owner` | that territory's actor, or `null` |
| `findings[].ownerType` | `human` or `llm-agent`, or `null` |
| `findings[].fatal` | whether this finding fails the gate |
| `findings[].note` | present only where a finding needs explaining |

## Attribution

A change is attributed to exactly one declared actor; how the surrounding tooling decides which one is outside the map, so this tool is told.
Confinement is symmetric: a change fails when it reaches a path its actor does not own, whether that actor is a human or an llm-agent.
No subject passes trivially.

## Classification

| classification | meaning | fails |
| --- | --- | --- |
| `owned` | inside a territory the subject may change | no |
| `foreign` | owned by another territory | yes |
| `unowned` | no territory claims it | only where the posture is `fail` |

Whether an unowned path fails is the **map's** decision, not the caller's: the effective posture is the repository's `unowned`, else the map's, else `fail`.
There is deliberately no flag to override it, because a caller that could opt out of fail-closed would make the posture meaningless.

Ownership is a single lookup rather than a precedence contest, since territories do not overlap.
A path claimed by two territories means the map is invalid, so the gate reports that and exits 2 instead of guessing which owner wins.

## Globs and exclusions

`src/glob.ts` implements the map's dialect: `**` matches zero or more whole segments and may collapse to nothing, `*` stays within one segment, `?` is one character, `[`/`{`/`!` are literal, matching is case-sensitive, and a glob matches files rather than directories.
Dot-prefixed paths are ordinary paths: `**` claims `.github/workflows/ci.yml` like anything else.
The cases that distinguish it from gitignore and doublestar are pinned in `test/glob.test.ts`, because every other implementation of this dialect has to agree with it.
A glob the dialect rejects makes the whole map invalid, reported before any path is matched rather than whenever one happens to reach it.

A scope entry's `exclude` subtracts from its own globs: `exclude.globs` by pattern, `exclude.territories` by naming a territory whose declared globs for this repository are removed.
Subtraction by territory is not recursive, and exclusion never assigns the excluded path to anyone.

## Reading the diff

A unified diff is expected, and a plain path list from `git diff --name-only` works too.
Both sides of a rename count, C-quoted and non-ASCII paths are decoded, and content that merely looks like a file header, such as a deleted line reading `-- x`, is not mistaken for one.
The parser errs toward reading more paths than fewer, since a path it misses is a violation it silently permits.

`git diff` does not report untracked files until they are marked, which is what `git add -AN` in the examples above is for.

## Repositories

A diff carries no indication of which repository it came from, so a map governing more than one has to be told with `--repo`.
Scope entries are matched per repository, so a territory spanning repositories never leaks one repository's globs into another.

## Scope

This tool checks diff scope and nothing else.
It does not validate the map beyond the shape it reads, so a map that passes the gate is not necessarily a valid map, and it does not check dependency edges - `dependsOn` and the `undeclaredDependencies` posture belong to an import-boundary tool.
