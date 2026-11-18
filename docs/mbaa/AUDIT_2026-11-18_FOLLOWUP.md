# Follow-up audit (2026-11-18) — what the first audit got wrong, and what it missed

This reads `AUDIT_2026-11-17.md` against the code it describes. Every claim
below was checked by building and running, not by reading: the base the audit
names (`stevenvinhtran/wine-assembly` @ `8e79a8637`), the pinned submodule
commit (`7cd76efab`), and the patch applied to a clean checkout.

Reproduce the whole chain before trusting any of it:

```bash
git clone https://github.com/potatoei/wine-assembly.git wa && cd wa
git checkout 8e79a8637770811939ead0d4a74e2d8a5cd09053
git am /path/to/docs/mbaa/mbaa-engine-fixes.patch     # 2 commits, no conflicts
npm install --omit=dev
bash tools/build.sh                                   # 1765269 bytes
bash tools/check-test-manifest.sh                     # 1837 files
```

Verified results, so you do not have to take them on faith:

| Check | Result |
|---|---|
| `git am` of the patch onto `8e79a8637` | clean, 2 commits |
| Patch output vs the pinned submodule commit `7cd76efa` | **`git diff` is empty** — the patch reproduces the commit byte-exactly |
| `bash tools/build.sh` | `1765269 bytes`, region hash `c4c5e06a29d651ae`, exit 0 |
| `bash tools/check-test-manifest.sh` | `1837 files`, OK |
| The seven tests the runbook lists | all `PASS` |

So the runbook's "green build, 1837 tests, 8 PASS lines" is accurate, and the
submodule pointer is honest. That is worth saying plainly, because the rest of
this document is about what the green numbers do **not** cover.

---

## 1. The documented ReadFile fix is real, but not the one that is described

`AUDIT §3` and the patch's first commit claim the WAT `ReadFile` OVERLAPPED
branch "wrote the count only to `OVERLAPPED.InternalHigh` and never through
`lpBytesRead`". The patch's diff for `src/09a7d-handlers-shell-file.wat` is
**comment-only** — no instruction changed. The reason is in the base commit:

```wat
(local.set $bytes (call $gl32 (i32.add (local.get $arg4) (i32.const 4))))
(if (local.get $arg3) (then (call $gs32 (local.get $arg3) (local.get $bytes))))
```

`8e79a8637` **already** writes the count to `*lpBytesRead` when non-NULL. The bug
the audit describes did not exist in the file it describes. The commit message
and the runbook both present it as a fix.

This matters beyond bookkeeping: it means the "The / Th / The..." dialogue
symptom was never explained by that code path, and anyone re-reading this audit
to find the cause will be led somewhere that has no defect. The *JS* half of the
same commit is real (see below), so the change is not harmful — it is
mislabelled.

**What is actually true about the park path.** `lib/filesystem.js` did zero
`*lpBytesRead` on entry and again on every park. Both are now removed, with
tests (`test/test-readfile-park-idempotence.js`). That is a genuine contract fix
and it is the only part of the dialogue story with code behind it.

## 2. The audit's own MBAACC entry contradicts its diagnosis

`AUDIT §3` blames "two threads share a handle" for the tearing. `lib/apps.js`
declares the app:

```js
mbaa: { ..., threads: false, ... }
```

`host.js` `_maybeStartGuestWorker` returns early for `threads: false`, so the
whole guest — every "thread" — runs in one scheduler inside one Worker. There is
no cross-thread handle race to have. The mechanism may exist for other apps; it
cannot be the cause of a symptom in an app that opts out of the only thing that
creates it. The audit needed a browser session here and says so; it should not
also have asserted the mechanism.

## 3. The texture census could silently pin the wrong bytes — fixed

`tools/mbaa-texture-census.js` reads a member's extent as "start to the next
entry in the name table". That is only correct when the table is sorted by file
offset. A container may store its table in any order, and when it is not sorted:

- a member whose table-neighbour sits **earlier** in the file got
  `end === start` → `length 0` → `classify()` returns `other` → **the texture is
  never pinned**, silently;
- the member before it in the file swallowed every byte between them, so its
  length was nonsense and its classification meaningless.

Reproduced on a 3-member archive whose table is ordered `a, c, b` while the file
is `a, b, c` — the unfixed tool reported `pinning 1 range(s), 41%` where the
fixed tool reports `pinning 2 range(s), 69.6%`, and the missing member is the
texture:

```
before: texture:raw 772 @0x48 a_tex.bin | other 0 @0x34c c_tex.bin | other 1540 @0x158 b_other.bin
after:  texture:raw 272 @0x48 a_tex.bin | texture:raw 1040 @0x34c c_tex.bin | other 500 @0x158 b_other.bin
```

That failure mode is the exact one the tool's own header says it exists to
prevent ("a texture that is resident but wrong is worse than one that streams
slowly") and it produced no message at all. Fixed by deriving extents from the
sorted offset list; regression test added to
`test/test-mbaa-texture-census.js` (verified to fail against the unfixed tool).

## 4. Three silent no-ops in the preload policy — fixed

`lib/app-files.js` emitted declarations that either throw at launch or do
nothing, in three separate ways:

1. **An unsized `preloadAssets` name** became `{loadMode:'required', size:null}`.
   `host.js` validates `Number.isSafeInteger(item.size)` and throws
   `Invalid manifest size` — a hard launch failure from a typo or a missing size.
   Now left streaming, reported in `summary.preloadSkipped`, warned once.
2. **A `preloadRanges` key** was compared case-sensitively against the URL leaf.
   `{"0002.P": …}` (or any rename on the way in) matched nothing, and the archive
   fell back to a **whole-file preload** — a 900 MB launch from a table that looks
   correct. Keys now resolve exactly as `preloadAssets` names do: exact key, URL,
   then a case-insensitive leaf.
3. **A list measured on other bytes** was refused (correctly) and silently
   (not correctly). It now names the file and both sizes in the console, because
   the remedy — re-run the census against the deployed file — is not guessable
   from a fallback. A table no file ever consulted is likewise reported once.

All four behaviours are pinned in `test/test-app-files-switches.js`.

## 5. What the patch claims but does not implement

Two items in `AUDIT §1`/§8.1 are described as landed and are not in the code:

- **`texturePreload: { '0002.p': 'required' }`** — `grep -r texturePreload`
  returns nothing. The mechanism that shipped is `preloadAssets` +
  `preloadRanges`, which is fine, but the document describes a knob that does
  not exist.
- **`cache.critical` fail-closed retry** (`AUDIT §2`: "a small, contained change
  in `_fillParkedRead`'s failure branch keyed on a new `cache.critical` flag") —
  no `critical` flag exists in `lib/` or `host.js`. The only remedy actually
  shipped for the black-battle report is preloading. Worth being explicit,
  because §2 presents fail-closed as the safety net under a guest that caches
  `NULL` forever, and there is no safety net: a failed fill is still
  `ERROR_READ_FAULT` to the guest.

## 6. Still needs a browser (unchanged from the first audit)

The measurements the first audit asked for are still the right ones and still
unmade. Nothing above replaces them:

- a HUD screenshot during a 20 FPS menu — `park/s` vs `fill/s` names the cause;
- `?d3d9-audit=textures` from a battle with white placeholders;
- `ranges-0002.json` from the real archive, so the launch stops being ~1 GB.

---

## Files changed in this follow-up

Complete drop-in replacements are in `docs/mbaa/fixed/`; the patch is
`docs/mbaa/fixed/mbaa-remaining-fixes.patch` (applies on top of the two commits
the existing patch lands):

| File | What changed |
|---|---|
| `tools/mbaa-texture-census.js` | member extents from the sorted offset list, not the table successor |
| `lib/app-files.js` | unsized preload left alone + reported; ranges key resolution; refusal/unused reporting |
| `test/test-mbaa-texture-census.js` | unsorted-table regression (fails on the old tool) |
| `test/test-app-files-switches.js` | unsized preload, key spellings, size mismatch, unused table |
