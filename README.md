# mend: one patch tool for every AI edit format

[![make.fun](https://img.shields.io/badge/make.fun-hidden--spec--cli--01--run--20261122-blue)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![owner](https://img.shields.io/badge/owner-putriwindiasty22-green)](https://github.com/putriwindiasty22)
[![repo](https://img.shields.io/badge/repo-hidden--spec--cli--01--run--20261122-lightgrey)](https://github.com/putriwindiasty22/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON — and `mend` reads all four, finds the lines each edit
names at the first of three matching tiers, and writes every change or none, printing what it
changed or why it failed.

This repository is an entry for the make.fun bounty
[`hidden-spec-cli-01-run-20261122`](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
($100, free). Referral code: `j9d1a2d9`. The full contract is `SPEC.md`.

## Run

Requires Node.js 22 and nothing else — standard library only, no install step, no model calls.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Example

```sh
$ cat fix.patch
--- a/greet.js
+++ b/greet.js
@@ -1,3 +1,3 @@
 function greet(name) {
-  return "hello " + name;
+  return "hello, " + name + "!";
 }
$ node main.ts fix.patch
M greet.js
ok: 1 file
```

A patch that changes nothing prints only `ok: 0 files`; a patch that cannot apply prints
one `error:` line per failed edit and writes nothing at all.

## Exit codes and output

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or `R old -> new`),
  then `ok: <n> files` (or `ok: 1 file`).
- Exit 1: nothing is written. One `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`.
- Exit 2: nothing is written, exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Matching

An edit's old lines are found at the first of three tiers at which they occur at least once:
tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and
trailing spaces and tabs ignored, with new lines re-indented onto the file's own indentation).
`--strict` tries tier 0 only.

## Files

- `main.ts`: the CLI. In a trial, when `MAKEFUN_ENV_URL` is set, it hands over to `runner.ts`.
- `runner.ts`: the kit's runner, kept as it is.
- `check.ts`: the practice set on your own machine:
  `node check.ts ../program/generator/practice.json`.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
