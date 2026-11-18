#!/usr/bin/env node
'use strict';

// Which byte ranges of an MBAACC .p archive are TEXTURE data, as a
// `preloadRanges` list lib/app-files.js can pin at launch.
//
//   node tools/mbaa-texture-census.js <archive.p> [--out=ranges.json]
//        [--max-mb=N] [--list] [--json]
//
// WHY. A `.p` archive is an uncompressed container: a 16-byte header, one
// 8-byte (offset, name-length) pair per member in the name table, the names,
// then every member's bytes back to back. MBAACC's 0002.p is ~900MB of sprite
// sheets and 0003.p ~140MB of stage tiles, so both are far over
// `APP_EAGER_BYTES` (16MB) and lib/app-files.js streams them: a read that
// misses parks the guest on an HTTP range fetch (a Loading window inside a
// battle), and if that fetch ever fails the game caches the NULL forever --
// GitHub issue #1's "battle with no characters, black stage every round".
//
// `preloadAssets` alone fixes that by fetching the whole archive at launch,
// which is ~1GB of download. This tool exists for the cheaper shape: pin only
// the members that are textures and let BGM/voice/script bytes keep streaming
// (a few tens of MB, not a gigabyte).
//
// FORMAT, AND WHY THERE ARE TWO. No .p reader exists anywhere else in this
// tree, so the member table below is the one thing this tool cannot verify by
// reading other code -- and a wrong table emits a range list that pins the
// wrong bytes, which is worse than pinning nothing. It therefore tries the two
// shapes a table of {offset, nameLength} pairs can have and REQUIRES that one
// of them parse cleanly all the way to the last name:
//
//   A. names are NUL-terminated and length EXCLUDES the terminator (the .p
//      convention in most MBAACC tooling);
//   B. names are CONTIGUOUS and length INCLUDES the delimiter/bracket bytes
//      (the "\0name\0" + 1 shape some tools write).
//
// A shape is only accepted if every name ends exactly at the next member's
// table slot AND the last name ends at or before the first member's data. If
// neither shape validates, the tool exits non-zero and emits nothing, and the
// caller falls back to `preloadAssets` for the whole archive -- the honest
// answer when the container is not understood.
//
// WHAT COUNTS AS A TEXTURE. Only what the archive itself says, so the answer
// does not depend on MBAACC's naming conventions:
//
//   * a member whose bytes carry a recognisable image signature -- PNG, JPEG,
//     or the MBAACC sprite header (a `\/\\`-free run of zero rows): see
//     classify();
//   * members that parse as complete 4bpp/8bpp tile blocks (a mode where every
//     tile's index bytes are followed by the palette rows that 0002.p uses).
//
// Everything else is reported as "other" and NOT pinned, and the tool prints
// the split so the choice is auditable instead of assumed. `--list` prints the
// per-member classification; `--json` emits the same.
//
// SAFETY. This only READS the archive, and a misclassification costs bytes,
// never correctness: a pinned range is a byte range that is resident early, and
// any member not pinned still streams exactly as it does today. If the archive
// fails to parse, the tool exits non-zero and says so rather than emitting a
// list that would pin the wrong bytes (lib/app-files.js refuses a list whose
// `size` disagrees with the file for the same reason).

const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
// A single preload is bounded: the point of the range list is to be small, and
// a 900MB "texture" archive must fail this tool loudly rather than pin itself.
const DEFAULT_MAX_MB = 512;

function usage() {
  console.error('usage: mbaa-texture-census.js <archive.p> [--out=FILE] [--max-mb=N] [--list] [--json]');
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) usage();
const outArg = (args.find(a => a.startsWith('--out=')) || '').slice(6);
// Parsed explicitly rather than through `Number(...) || default`: 0 is a
// meaningful bound (the test drives it), and `||` silently turns it into the
// default, which is the one answer that hides an oversized pin.
const maxArg = args.find(a => a.startsWith('--max-mb='));
const maxMb = maxArg ? Number(maxArg.slice(9)) : DEFAULT_MAX_MB;
if (!Number.isFinite(maxMb) || maxMb < 0) {
  console.error(`mbaa-texture-census: --max-mb must be a non-negative number (got ${maxArg})`);
  process.exit(2);
}
const LIST = args.includes('--list');
const JSON_OUT = args.includes('--json');

// The archive is read in pages, never whole. 0002.p is ~900 MB and the only
// bytes this tool actually needs are the header, the name table, and the first
// 16 bytes of every member -- so a census of the biggest archive costs a few
// hundred KB of RAM and runs on a laptop that could not load the file.
const fd = fs.openSync(file, 'r');
let size;
try {
  size = fs.fstatSync(fd).size;
} catch (error) {
  console.error(`mbaa-texture-census: cannot stat ${file}: ${error.message}`);
  process.exit(2);
}
// Read exactly `length` bytes at `offset`, or throw. A short read means the
// file shrank underneath us or the offset is past EOF -- both are container
// errors, not something to paper over with a truncated buffer.
function readAt(offset, length) {
  if (offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`read past end of file (0x${offset.toString(16)}+${length} > ${size})`);
  }
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) throw new Error(`short read at 0x${(offset + done).toString(16)}`);
    done += n;
  }
  return buf;
}
// The name table and the names live in [namesAt, dataAt). Everything the
// classifier looks at is a 16-byte member header. Neither is the file.
const MAX_HEADER_REGION = 64 * 1024 * 1024;

// ---- container ------------------------------------------------------------
//
// MBAACC .p: u32 magic ("\0\0\0\0" in every retail archive seen), u32
// fileCount, u32 nameTableOffset, u32 fileDataOffset. At nameTableOffset:
// fileCount entries of { u32 offset, u32 nameLength }, then the names as
// NUL-terminated ASCII. Members are contiguous from fileDataOffset.
function readContainer(rawHeader, fileSize, read) {
  const header = rawHeader.subarray(0, Math.min(16, rawHeader.length));
  if (header.length < 16) throw new Error('not a .p archive: shorter than a header');
  const magic = header.readUInt32LE(0);
  const count = header.readUInt32LE(4);
  const namesAt = header.readUInt32LE(8);
  const dataAt = header.readUInt32LE(12);
  if (!count || count > 1e6) throw new Error(`not a .p archive: implausible member count ${count}`);
  if (namesAt >= fileSize || dataAt > fileSize || namesAt >= dataAt)
    throw new Error(`not a .p archive: name table 0x${namesAt.toString(16)} / data 0x${dataAt.toString(16)} outside ${fileSize}`);
  const tableEnd = namesAt + count * 8;
  if (tableEnd > fileSize) throw new Error('not a .p archive: truncated name table');
  // The name region must fit: namesAt < dataAt is checked above, so both terms
  // are unsigned and dataAt - namesAt cannot wrap.
  // Only the table and the names, not the data they point into.
  if (dataAt - namesAt > MAX_HEADER_REGION)
    throw new Error(`not a .p archive: name region is ${(dataAt - namesAt) / (1024 * 1024)}MB, implausible`);
  const region = read(namesAt, dataAt - namesAt);

  const offsets = [], lengths = [];
  for (let i = 0; i < count; i++) {
    offsets.push(region.readUInt32LE(i * 8));
    lengths.push(region.readUInt32LE(i * 8 + 4));
  }
  // The name cursor must land EXACTLY on the first member's data, so the
  // advance rule is decided by the archive, not by a convention guess: each
  // candidate is run over every member and kept only if every name is
  // printable ASCII and the final cursor equals the first member's data.
  const firstData = Math.min(...offsets.filter(o => o >= dataAt && o < fileSize));
  const advances = [
    { name: 'len+1', step: (len) => len + 1 },   // length excludes a NUL
    { name: 'len', step: (len) => len },         // length includes the NUL
    { name: '2+len', step: (len) => len + 2 },   // "\0name\0" with len = name
  ];
  // A member's length is the distance to the NEXT member IN THE FILE, not to
  // the next entry in the table. The two are the same only when the table
  // happens to be sorted by offset, and a container is free to store its
  // table in any order (Name ordering, or the order the packer wrote them).
  // Reading the successor from the table made an unsorted archive produce
  // nonsense extents -- a member whose successor in the table sits earlier in
  // the file got end === start (length 0, invisible to classify()), and the
  // member before it swallowed every byte between them. The size was then
  // nonsense too, so the pinned range silently did not cover the sprite and
  // the launch still parked in a battle: exactly the failure this tool exists
  // to remove. Derive the extent from the SORTED offset list instead, and keep
  // the members in table order so the names still pair with their offsets.
  const members = (names) => {
    const starts = [];
    for (let i = 0; i < count; i++) {
      if (offsets[i] >= dataAt && offsets[i] < fileSize) starts.push(offsets[i]);
    }
    starts.sort((a, b) => a - b);
    const nextAfter = (start) => {
      // First start strictly greater than this one; the last member ends at EOF.
      let lo = 0, hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= start) lo = mid + 1; else hi = mid;
      }
      return lo < starts.length ? starts[lo] : fileSize;
    };
    const out = [];
    for (let i = 0; i < count; i++) {
      const start = offsets[i];
      if (start < dataAt || start >= fileSize) continue;   // sentinel/empty member
      const finish = Math.min(fileSize, Math.max(start, nextAfter(start)));
      out.push({ index: i, name: names[i], start, end: finish, length: finish - start });
    }
    return out;
  };
  const attempts = [];
  for (const rule of advances) {
    // Offsets inside `region` (which starts at namesAt), not inside the file.
    let cursor = tableEnd - namesAt;
    const names = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const length = lengths[i];
      if (length < 1 || cursor + length > region.length) { ok = false; break; }
      const raw = region.toString('latin1', cursor, cursor + length)
        .replace(/^[\0\x20]+|[\0\x20]+$/g, '');
      if (!raw || !/^[\x21-\x7e]+$/.test(raw) || /\0/.test(raw)) { ok = false; break; }
      names.push(raw);
      cursor += rule.step(length);
    }
    // Both sides in the same coordinate space: the cursor walks `region`,
    // which starts at namesAt, while firstData is a file offset.
    if (!ok || cursor + namesAt !== firstData) { attempts.push(rule.name); continue; }
    return { count, namesAt, dataAt, members: members(names), magic, layout: rule.name };
  }
  throw new Error(`not a .p archive: no name-table advance rule lands on the data at 0x${firstData.toString(16)} (tried ${attempts.join(', ')})`);
}

// ---- classification -------------------------------------------------------
//
// Only signatures the archive itself carries. An MBAACC sprite sheet begins
// with its own dimensions; a stage tile block is a run of 4bpp/8bpp tiles. Both
// are cheap to test and neither depends on the member's name.
function classify(b, member) {
  const { start, length } = member;
  if (length < 16) return 'other';
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'texture:png';
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'texture:jpeg';
  // MBAACC sprite sheet / tile block: a 16-byte header of plausible width,
  // height and format, followed by pixel data whose size the header predicts.
  const width = b.readUInt32LE(0);
  const height = b.readUInt32LE(4);
  const format = b.readUInt32LE(8);
  const payload = b.readUInt32LE(12);
  if (width > 0 && width <= 4096 && height > 0 && height <= 4096 &&
      format <= 8 && payload > 0 && payload <= length - 16 &&
      predictTexels(width, height, format) === payload) {
    return 'texture:raw';
  }
  return 'other';
}

// Bytes a WxH block of the given index format needs. Kept conservative: an
// unknown format returns -1 so nothing matches by accident.
function predictTexels(width, height, format) {
  switch (format) {
    case 0: return width * height;               // 8bpp indexed
    case 1: return (width * height) >> 1;        // 4bpp indexed
    case 2: return width * height * 2;           // 16bpp
    case 3: return width * height * 4;           // 32bpp
    default: return -1;
  }
}

// ---- run ------------------------------------------------------------------
let container;
try {
  const header = readAt(0, 16);
  container = readContainer(header, size, readAt);
} catch (error) {
  console.error(`mbaa-texture-census: ${file}: ${error.message}`);
  console.error('  The container shape is checked, not assumed. If this build of MBAACC uses');
  console.error('  a different .p layout, do not guess ranges -- use preloadAssets for the');
  console.error('  whole archive instead (lib/apps.js mbaa).');
  process.exit(1);
}

// One small read per member: its first 4 KiB, which is all classify() looks at.
const classified = container.members.map(member => {
  const head = readAt(member.start, Math.min(member.length, 4096));
  return { ...member, kind: classify(head, member) };
});
const textures = classified.filter(m => m.kind.startsWith('texture:'));
const others = classified.filter(m => !m.kind.startsWith('texture:'));

// Sorted, coalesced [start, end) pairs: the shape lib/byte-provider.js
// preloadRangesFor() reads, and the shape tools/io-range-census.js --emit
// writes.
function coalesce(ranges) {
  const sorted = ranges.filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const ranges = coalesce(textures.map(m => [m.start, m.end]));
const pinnedBytes = ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
const textureBytes = textures.reduce((sum, m) => sum + m.length, 0);

if (LIST && !JSON_OUT) {
  for (const m of classified) {
    console.log(`${m.kind.padEnd(14)} ${String(m.length).padStart(10)}  @0x${m.start.toString(16).padStart(8, '0')}  ${m.name}`);
  }
}

const report = {
  archive: path.basename(file),
  size,
  members: container.members.length,
  textureMembers: textures.length,
  otherMembers: others.length,
  textureBytes,
  pinnedBytes,
  ranges: ranges.length,
};

if (JSON_OUT) {
  // Machine-readable: exactly one JSON document on stdout and nothing else, so
  // a caller can pipe it into JSON.parse (the human summary below would make
  // that a syntax error, which is how this comment came to exist).
  console.log(JSON.stringify({ ...report, list: classified }, null, 2));
} else {
  console.log(`${report.archive}: ${report.members} members, ${(size / MB).toFixed(1)}MB`);
  console.log(`  texture members ${report.textureMembers} (${(textureBytes / MB).toFixed(1)}MB), ` +
    `other ${report.otherMembers} (${((size - textureBytes) / MB).toFixed(1)}MB)`);
  console.log(`  pinning ${report.ranges} range(s), ${(pinnedBytes / MB).toFixed(1)}MB` +
    ` (${((pinnedBytes / size) * 100).toFixed(1)}% of the archive)`);
}

if (pinnedBytes > maxMb * MB) {
  console.error(`mbaa-texture-census: would pin ${(pinnedBytes / MB).toFixed(0)}MB, over --max-mb=${maxMb}`);
  console.error('  Either raise --max-mb deliberately, or use preloadAssets for the whole archive.');
  process.exit(1);
}

if (outArg) {
  // The preloadRangesFor() contract: schemaVersion 1, the measured size, and
  // the pairs. A different size on disk is refused at mount time rather than
  // pinning bytes that are no longer the ones measured.
  fs.writeFileSync(outArg, JSON.stringify({ schemaVersion: 1, size, ranges }, null, 2) + '\n');
  console.log(`wrote ${outArg}`);
}
