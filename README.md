[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![make.fun rank](https://make.fun/badge/site-generator-speed-01-run-20261122/emasinves0-commits/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![make.fun reward](https://make.fun/badge/site-generator-speed-01-run-20261122/emasinves0-commits/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Swiftmark — a faster makefun-site

A drop-in replacement for **makefun-site 1.0.0** (make.fun's own static site
generator) that answers **byte for byte identically** on every case, in about
a third of the CPU time.

Entry for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122)
"Build a static site faster, 22 November 2026" ($100, $10 each for places 1–10).

## What it is

`solve.js` is a single dependency-free ES module (961 lines). Its `run(input)`
takes one generated site — `{ site, templates, files }` — and returns the
output tree as a JSON object of path → text, exactly as makefun-site 1.0.0
does: front matter, permalinks, its own Markdown dialect, collections, tags,
layouts, and the build report. `main.ts` is the kit's own driver (unchanged):
it reads `/input/cases.json`, answers each case alone with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference does the same work with regexes and string copies at every
step. Swiftmark keeps the pipeline and the output, and removes the waste:

- **Markdown, one pass.** Block detection by prefix (`charCodeAt`) — a regex
  runs only when its prefix matches. Inline rendering is slice-based and
  range-based: plain runs are bulk-escaped only when they hold an escapable
  character, nested spans recurse over ranges instead of substrings, and
  inline output goes straight into the block's output array.
- **Templates compiled once per case** to JS functions via `new Function`
  (array push + join, plain loops, scope-chain lookup), instead of walking an
  AST node by node for every page.
- **No repeated work.** `slugify` and `longDate` memoized per run; `resolvePath`
  memoized per run; the post card is built once and reused by its page; word
  counting is a native regex scan with no match array. Per-run caches reset at
  the top of `run()` — nothing is cached from one case to the next, per the
  rules.
- **No wasted copies.** `\r\n` normalisation skipped when the text holds no
  `\r`; front matter found by `indexOf` instead of split-and-rejoin; blocks
  accumulate into one output array with a single final join.

## Benchmark (local, practice set)

3 cases, 1,070 Markdown sources, ~2.77 MB input, Node v24.22.1 on this VM,
steady state over 10 rounds:

| | CPU time (3 cases) |
|---|---|
| makefun-site 1.0.0 (house baseline) | ~650 ms |
| **Swiftmark (this entry)** | **~200 ms** |

About **3.1× faster** than the baseline on the same cases.

## Correctness

- Kit scorer on the practice set: **3/3 cases, passed**.
- Differential test against the reference oracle on 9 further generated cases
  (3 sets, seeds `test-seed-aaa` / `test-seed-bbb` / `test-seed-ccc`):
  **9/9 byte-identical**. Total **12/12 cases identical**.
- Full end-to-end run through `main.ts` (the real driver): **3/3, passed**.

## Layout

- `solve.js` — the generator (the entry).
- `main.ts` — the kit's driver, unchanged.
- `package.json` — `{"type": "module"}`.
- `BUILD-REPORT.md` — benchmark detail, session IDs, remote HEAD.

## License

MIT — see `LICENSE`.
