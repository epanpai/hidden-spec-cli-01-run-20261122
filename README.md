# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/epanpai/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/epanpai/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one command-line tool that applies the edits AI models write, in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — to a tree of text files. It finds the lines an edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive with re-indentation), and changes every file or none, printing what it changed or why it failed. Node 22, standard library only.

## Run it

```sh
node main.ts [options] [PATCH]
```

`main.ts` reads a patch file (or standard input when PATCH is absent or `-`), detects its format (`--format=unified|search-replace|v4a|json|auto`), and applies it to the working directory. `--check` previews without writing, `--strict` matches lines exactly (tier 0 only). See `SPEC.md` for the full contract; `check.ts` runs the kit's 100 public practice checks against `main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xweavw8m&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
