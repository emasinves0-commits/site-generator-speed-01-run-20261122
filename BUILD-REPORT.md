# BUILD-REPORT — Swiftmark (site-generator-speed-01-run-20261122)

**Entry:** a faster drop-in for makefun-site 1.0.0 — `solve.js`, a single
dependency-free ES module (961 lines, 34,519 bytes) whose `run(input)` returns
the output tree byte for byte identically to the reference, in about a third
of the CPU time.

**Bounty:** [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
— "Build a static site faster, 22 November 2026". Prize $100 total, $10 each
for places 1–10. Deadline 24 Nov 20:00 UTC. Metric: CPU time (µs), trimmed
mean of 9 timed runs after 1 untimed warm-up, lower better, net of a
do-nothing control. A reward needs beating makefun-site (the house baseline)
at 95% confidence. Every answer must be identical to makefun-site 1.0.0's;
nothing cached from one case to the next. Repo ≤ 4 MiB.

**Repo:** https://github.com/emasinves0-commits/site-generator-speed-01-run-20261122
(created 22 Nov 20:14:35 UTC, after the competition opened at 20:00 UTC).
**Remote HEAD at report time:** `2c7142212c07f31f57097be9658b10b651cf27ad`
(the 5-file push; this report's own push is one commit later — see the
parent's submit record for the final HEAD).

## Benchmark

Practice set, 3 cases, 1,070 Markdown sources, ~2.77 MB input, Node v24.22.1
on this VM. Steady state over 10 rounds (rounds 4–10: 196/208/190/207/260/241/196 ms):

| | CPU time (3 cases) | Wall |
|---|---|---|
| makefun-site 1.0.0 (house baseline, kit copy) | ~650 ms (median; best 581) | ~520–710 ms |
| **Swiftmark (this entry)** | **~200 ms (median; best 190)** | **~157–238 ms** |

**About 3.1× faster than the baseline** on the same cases, measured
back-to-back in the same window.

Dev-board context (checked 23 Nov ~02:44 UTC, 3,199 entries, all passing):
rank 1 at 180,000 µs, rank 2 at 360,000, rank 10 at 500,000, rank 30 at
640,000. If the sandbox is ~1.5× slower than this VM, this entry lands around
300–375 ms on the dev board (rank ~2–4); at 2× slower, ~400–500 ms (rank
~8–10, borderline). Either way it is competitive for a paid place — and it
beats the house baseline by a wide margin, which is the requirement for any
reward.

## Correctness

- Kit scorer on the practice set: **passed 1, 3/3 cases**.
- Differential test vs the reference oracle on 9 further generated cases
  (3 sets drawn with the kit's `draw.ts`, seeds `test-seed-aaa` /
  `test-seed-bbb` / `test-seed-ccc`): **9/9 byte-identical**.
- Total: **12/12 cases byte-identical** to makefun-site 1.0.0.
- Full end-to-end run through `main.ts` (the real driver, `node main.ts`
  with `MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR`): **3/3, passed**,
  answers.json 7,446,432 bytes.
- Every optimization round was re-verified (scorer + all 3 differential
  sets) before the next round started.

## How it is faster

1. **Markdown, one pass.** Block detection by prefix (`charCodeAt`); a regex
   runs only when its prefix matches. Inline rendering is slice-based and
   range-based (no per-character escape/replace, no substring copies for
   nested spans); plain runs are bulk-escaped only when they hold an
   escapable character; inline output goes straight into the block's output
   array; blocks accumulate into one array with a single final join.
2. **Templates compiled once per case** to JS functions via `new Function`
   (array push + join, plain loops, static loop-var objects, scope-chain
   lookup helper), instead of walking an AST per page.
3. **No repeated work.** `slugify` and `longDate` memoized per run;
   `resolvePath` memoized per run; the post card is built once and reused by
   its page; word counting is a native regex scan with no match array;
   scope lookup uses plain reads (no scope var is ever explicitly undefined).
   All per-run caches reset at the top of `run()` — nothing is cached from
   one case to the next, per the rules.
4. **No wasted copies.** `\r\n` normalisation skipped when the text holds no
   `\r`; front matter found by `indexOf` instead of split-and-rejoin;
   `trimLine` fast-paths clean lines (no regex, no allocation); the input
   file list is sorted in place.

## Files

| File | Bytes | Notes |
|---|---|---|
| `solve.js` | 34,519 | The entry. Agent-written, all 961 lines. |
| `main.ts` | 1,579 | The kit's driver, copied verbatim (sets `--no-incremental-marking`, reads cases, writes answers). |
| `package.json` | 23 | `{"type": "module"}`. |
| `README.md` | 3,658 | 3 live make.fun badges + bounty link + benchmark. |
| `LICENSE` | 1,095 | MIT, `SPDX-License-Identifier: MIT`. |
| `BUILD-REPORT.md` | — | This file. |

Total repo size ~41 KB, far under the 4 MiB limit.

## Push verification (GitHub contents API)

All 5 code/doc blobs verified byte-identical to local files (blob SHA match):

| File | Blob SHA |
|---|---|
| solve.js | `ed06895a014745e1fe677286758875fa5c787e0b` |
| main.ts | `6e648e0b5819872ec126a0f3fb39ce99f18b4e48` |
| package.json | `3dbc1ca591c0557e35b6004aeba250e6a70b56e3` |
| README.md | `732262106657e55410df018a2987bcd8cab30043` |
| LICENSE | `3e2f9da4794766247eb39b86a6ce8c5995eb222b` |

Remote HEAD after the 5-file push: `2c7142212c07f31f57097be9658b10b651cf27ad`.
About: homepage = bounty link, topic `makefun`.

## Sessions

- Build session (this subagent): `96aaba54-9bed-44d5-92f2-ffdca8a0fdf4`
  (label `4af53f62-a633-406e-b5b3-c87d62e21b8b`), spawned by the parent
  (main chat, agent `ec8d2ba0-7612-47a2-8e5b-3cadd45bc099`) 22 Nov 18:43 PST.
- Claude Code was NOT used (weekly limit until 24 Nov 03:00 UTC).
- Bundle/submit/vote are the parent's job — this report covers the build only.

## Local test assets (ephemeral, under /tmp/sgs-bench/)

`bench.mjs` (CPU-timed runner), `difftest.mjs` (oracle differential test),
`baseline/` (kit house copy), `gen-aaa/` / `gen-bbb/` / `gen-ccc/` (generated
sets + oracle answers), `prof/` + `prof2/` (CPU profiles), `out/` / `scores/`
(scorer runs), `fullrun/` (end-to-end driver run), `verify.py` (repo check).
Regenerate with the kit's `draw.ts` + `program/scorer/main.ts` if lost.

## Re-submit note (24 Nov 2026, ~06:00 UTC) — timing outage, code unchanged

The v1 entry (submission 01a2065c, received 23 Nov 03:03:54 UTC) passed the
gate (3/3 cases) but its dev-board `cpu_us` came back NULL, leaving it at
rank ~8,200 below all 7,893 timed entries. Diagnosis (stream-parse of the
full 8,443-entry board, 24 Nov ~05:45 UTC): the NULL timings cluster almost
entirely in ONE 2-hour window — 280 nulls received 23 Nov 02:00–03:00 UTC and
251 nulls 03:00–04:00 UTC (531 of 541 nulls); every other hour has 0–4. The
platform's timing service was evidently down in that window; our entry was
received inside it (03:03:54 UTC). This is a platform outage, not an entry
defect — the code is unchanged in this re-submit. Purpose: obtain a real dev
timing (expected ~300–500 ms on the sandbox by the local 200 ms benchmark)
and a true dev rank. The final re-grades every entry fresh on the scored set,
so this re-submit changes nothing about the final except the receipt time.
Code identical to v1: solve.js untouched (same 34,519 bytes).
