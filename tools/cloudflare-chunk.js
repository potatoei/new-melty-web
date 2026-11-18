#!/usr/bin/env node
'use strict';

// Split MBAACC assets into sequential parts under Cloudflare's object limit,
// deterministically, and emit the mapping the runtime and the uploader both
// need.
//
//   node tools/cloudflare-chunk.js <dir> --out=<dir> [--max-bytes=N]
//        [--only=0002.p,0003.p] [--manifest=FILE] [--verify-only] [--json]
//
// WHY THIS EXISTS, AND WHAT IT MUST NOT DO
//
// The engine reads these archives by HTTP RANGE (lib/byte-provider.js
// HttpRangeProvider, host.js _openRangeProvider, which joins `name.partNNN`
// with ConcatProvider). A part boundary is invisible to the guest *only* if
// concatenating the parts reproduces the original bytes exactly. So:
//
//   * NO COMPRESSION. A per-part .gz/.br would have to be inflated before the
//     Range semantics apply, and nothing in the loader does that; a compressed
//     part is served as compressed bytes and the guest reads garbage. If you
//     want transfer compression, that is `Content-Encoding` on the RESPONSE
//     (gzip/br/zstd), applied by the host per request -- which is exactly what
//     a Range request cannot use, because a byte range of the compressed
//     stream is not a byte range of the file. So: parts are raw, always.
//   * A SHORT PART MARKS EOF. The loader stops at the first part shorter than
//     ASSET_PART_SIZE, and an exact multiple needs an empty marker part after
//     it (tools/deploy-berrry.js). Reproducing that convention here is the
//     whole point: a stale higher-numbered part from an earlier, bigger upload
//     is then unreachable instead of being appended to the file.
//
// DETERMINISM. Part count and part bytes depend only on (input bytes,
// --max-bytes). No timestamps, no compression, no size-dependent padding, and
// the manifest records a SHA-256 per part and for the whole file so a re-run
// can be diffed rather than trusted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cloudflare's per-object limit is 25 MiB (26,214,400 bytes). Stay strictly
// under it: the object body must fit, and a value that rounds up to exactly the
// limit fails on some upload paths.
const CLOUDFLARE_MAX_OBJECT = 25 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;   // berrry's own split size
const HARD_MAX_BYTES = 24 * 1024 * 1024;      // headroom under the limit

// The LOADER's end-of-parts rule, which is NOT the same as the part size we
// write. host.js decides a part list is finished when a part is shorter than
// ASSET_PART_SIZE (host.js:552, 10 MiB). Two consequences, and the second one
// bit this tool:
//   * a part list whose last part is >= 10 MiB makes the reader fetch one more
//     part than exists;
//   * lib/byte-provider.js's ranged mount tolerates that (it breaks on the 404),
//     but host.js fetchAssetBytes -- the whole-file path used for a `required`
//     preload -- THROWS "missing <part>". Same split, works ranged, fails eager.
// So a trailing empty marker is emitted whenever the last part is not already
// below the threshold, not only on an exact multiple.
const LOADER_PART_EOF_BYTES = 10 * 1024 * 1024;   // host.js ASSET_PART_SIZE

function usage() {
  console.error('usage: cloudflare-chunk.js <dir> --out=<dir> [--max-bytes=N] ' +
    '[--only=a.p,b.p] [--manifest=FILE] [--verify-only] [--json]');
  process.exit(2);
}

const args = process.argv.slice(2);
const dirArg = args.find(a => !a.startsWith('--'));
if (!dirArg) usage();
const outArg = (args.find(a => a.startsWith('--out=')) || '').slice(6);
const manifestArg = (args.find(a => a.startsWith('--manifest=')) || '').slice(11);
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const maxArg = args.find(a => a.startsWith('--max-bytes='));
const VERIFY_ONLY = args.includes('--verify-only');
const JSON_OUT = args.includes('--json');

// Parsed explicitly: 0 is not meaningful here, but `Number(x) || default` would
// silently turn a malformed value into the default, which is the one answer
// that hides a typo.
let maxBytes = DEFAULT_MAX_BYTES;
if (maxArg) {
  maxBytes = Number(maxArg.slice(12));
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    console.error(`cloudflare-chunk: --max-bytes must be a positive integer (got ${maxArg})`);
    process.exit(2);
  }
  if (maxBytes > HARD_MAX_BYTES) {
    console.error(`cloudflare-chunk: --max-bytes=${maxBytes} is not strictly under Cloudflare's ` +
      `${CLOUDFLARE_MAX_OBJECT}-byte object limit; use <= ${HARD_MAX_BYTES}`);
    process.exit(2);
  }
}
if (!VERIFY_ONLY && !outArg) usage();

// The asset extensions this project actually ships. A directory walk that took
// everything would split build logs and screenshots too.
const ASSET_EXTENSIONS = new Set([
  '.p', '.bin', '.dat', '.exe', '.dll', '.wav', '.mp3', '.ogg', '.avi', '.bmp',
  '.png', '.jpg', '.jpeg', '.ttf', '.otf', '.wasm', '.pak', '.idx', '.sav',
  // An MBCZ container (tools/compress-assets.js) is chunked INSTEAD of the
  // archive it was packed from -- compress, then chunk, is the only order that
  // keeps the container's index offsets meaningful. Without this entry the
  // documented sequence failed with "--only names 0002.p.mbcz but the directory
  // has no such file", which reads as a missing file rather than an unlisted
  // extension.
  '.mbcz',
]);

function partName(name, index) {
  return `${name}.part${String(index).padStart(3, '0')}`;
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// One file -> its parts, in memory-order, plus the record a verifier can use.
// Streaming would halve peak RSS on a 900 MB archive; it is done in 4 MB
// slices so a big file does not need to be resident twice.
function splitFile(filePath, name, outDir) {
  const total = fs.statSync(filePath).size;
  const parts = [];
  const whole = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0, index = 0;
    const slice = Buffer.allocUnsafe(Math.min(maxBytes, 4 * 1024 * 1024));
    for (; offset < total; index++) {
      const length = Math.min(maxBytes, total - offset);
      const target = partName(name, index);
      const outPath = path.join(outDir, target);
      const out = fs.openSync(outPath, 'w');
      try {
        let written = 0;
        while (written < length) {
          const want = Math.min(slice.length, length - written);
          const got = fs.readSync(fd, slice, 0, want, offset + written);
          if (got <= 0) throw new Error(`short read at ${offset + written} of ${filePath}`);
          whole.update(slice.subarray(0, got));
          fs.writeSync(out, slice, 0, got);
          written += got;
        }
      } finally {
        fs.closeSync(out);
      }
      parts.push({ name: target, index, offset, length, sha256: sha256(fs.readFileSync(outPath)) });
      offset += length;
    }
    // An empty marker ends the list explicitly. It is needed whenever the last
    // real part is not already below the loader's EOF threshold -- which is
    // every exact multiple, but ALSO any tail between 10 MiB and maxBytes (a
    // 20 MiB part size leaves 10-20 MiB tails that the eager path cannot
    // terminate on). The marker is zero bytes, so it is also a valid KV value.
    const lastLength = parts.length ? parts[parts.length - 1].length : 0;
    if (total > 0 && (total % maxBytes === 0 || lastLength >= LOADER_PART_EOF_BYTES)) {
      const marker = partName(name, parts.length);
      fs.writeFileSync(path.join(outDir, marker), Buffer.alloc(0));
      parts.push({ name: marker, index: parts.length, offset: total, length: 0,
        sha256: sha256(Buffer.alloc(0)), marker: true });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { name, size: total, sha256: whole.digest('hex'), parts };
}

// Rebuild a split file and compare it with the source. This is the check that
// matters: parts that do not concatenate to the original are worse than no
// parts at all, and a manifest can be internally consistent while both are
// wrong.
function verifyFile(record, sourcePath, partDir) {
  const rebuilt = crypto.createHash('sha256');
  for (const part of record.parts) {
    if (part.marker) continue;
    // A manifest read back from disk carries no absolute paths (it must be
    // portable), so the parts are resolved against the directory they were
    // written to -- either the live split's or the `--out` given here.
    const partPath = part.path || (partDir && path.join(partDir, part.name));
    if (!partPath) throw new Error(`verify: no path for part ${part.name} of ${record.name}`);
    rebuilt.update(fs.readFileSync(partPath));
  }
  const got = rebuilt.digest('hex');
  if (got !== record.sha256) {
    return { ok: false, reason: `parts rebuild to ${got}, source is ${record.sha256}` };
  }
  if (sourcePath) {
    const source = sha256(fs.readFileSync(sourcePath));
    if (source !== record.sha256) {
      return { ok: false, reason: `source changed since split (${source} != ${record.sha256})` };
    }
  }
  return { ok: true };
}

// ---- run ------------------------------------------------------------------
const sourceDir = path.resolve(dirArg);
if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
  console.error(`cloudflare-chunk: ${sourceDir} is not a directory`);
  process.exit(2);
}
let names = fs.readdirSync(sourceDir)
  .filter(name => ASSET_EXTENSIONS.has(path.extname(name).toLowerCase()))
  .filter(name => !/\.part\d{3}$/.test(name))     // never re-split our own output
  .sort();
if (onlyArg) {
  const wanted = onlyArg.split(',').map(s => s.trim()).filter(Boolean);
  const missing = wanted.filter(name => !names.includes(name));
  if (missing.length) {
    console.error(`cloudflare-chunk: --only names ${missing.join(', ')} but the directory has no such file`);
    process.exit(1);
  }
  names = names.filter(name => wanted.includes(name));
}
if (!names.length) {
  console.error(`cloudflare-chunk: no asset files in ${sourceDir}`);
  process.exit(1);
}

if (VERIFY_ONLY) {
  if (!manifestArg) {
    console.error('cloudflare-chunk: --verify-only needs --manifest=FILE');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestArg, 'utf8'));
  let failed = 0;
  for (const record of manifest.files) {
    const result = verifyFile(record, path.join(sourceDir, record.name), outArg || sourceDir);
    if (!result.ok) { failed++; console.error(`FAIL ${record.name}: ${result.reason}`); }
    else console.log(`OK   ${record.name} (${record.parts.length} part(s), ${record.size} bytes)`);
  }
  process.exit(failed ? 1 : 0);
}

fs.mkdirSync(outArg, { recursive: true });
const files = [];
for (const name of names) {
  const record = splitFile(path.join(sourceDir, name), name, outArg);
  for (const part of record.parts) part.path = path.join(outArg, part.name);
  files.push(record);
}

// Verify what was just written, before claiming success.
let invalid = 0;
for (const record of files) {
  const result = verifyFile(record, path.join(sourceDir, record.name), outArg);
  if (!result.ok) { invalid++; console.error(`FAIL ${record.name}: ${result.reason}`); }
}

const manifest = {
  schemaVersion: 1,
  // The loader's contract, recorded so the uploader and the runtime cannot
  // disagree about where one part ends.
  partSize: maxBytes,
  conventions: {
    partName: '<name>.partNNN',
    shortPartMarksEof: true,
    eofThresholdBytes: LOADER_PART_EOF_BYTES,
    emptyMarkerWhenTailNotBelowEof: true,
    compression: 'none',
  },
  files: files.map(record => ({
    name: record.name,
    size: record.size,
    sha256: record.sha256,
    parts: record.parts.map((part, index) => ({
      name: part.name,
      index: part.index,
      offset: part.offset,
      length: part.length,
      sha256: part.sha256,
      ...(part.marker ? { marker: true } : {}),
    })),
    // The byte range of the WHOLE file each part covers, which is what a
    // preloadRanges list or a Content-Range check needs.
    ranges: record.parts.filter(p => !p.marker)
      .map(p => [p.offset, p.offset + p.length]),
  })),
  totals: {
    files: files.length,
    parts: files.reduce((n, f) => n + f.parts.length, 0),
    bytes: files.reduce((n, f) => n + f.size, 0),
  },
};

if (!JSON_OUT) {
  for (const record of files) {
    const biggest = record.parts.reduce((max, p) => Math.max(max, p.length), 0);
    console.log(`${record.name}: ${record.size} bytes -> ${record.parts.length} part(s), ` +
      `largest ${biggest} (limit ${CLOUDFLARE_MAX_OBJECT})`);
  }
  console.log(`total: ${manifest.totals.files} file(s), ${manifest.totals.parts} object(s), ` +
    `${manifest.totals.bytes} bytes`);
}

if (manifestArg) {
  fs.writeFileSync(manifestArg, JSON.stringify(manifest, null, 2) + '\n');
  if (!JSON_OUT) console.log(`wrote ${manifestArg}`);
}
if (JSON_OUT) console.log(JSON.stringify(manifest, null, 2));

if (invalid) {
  console.error(`cloudflare-chunk: ${invalid} file(s) did not rebuild byte-for-byte; do not upload these parts`);
  process.exit(1);
}
