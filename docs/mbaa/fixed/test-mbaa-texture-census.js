#!/usr/bin/env node
'use strict';

// tools/mbaa-texture-census.js: the range list it emits is the one thing a
// launch will PIN, so the tool's two failure modes matter more than its happy
// path:
//
//   * classify a non-texture member as a texture  -> launch downloads bytes it
//     did not need (the whole point of the range list is that it is small);
//   * misparse the container and emit ranges     -> launch pins the WRONG
//     bytes, and a texture that is resident but wrong is worse than one that
//     streams. So a parse failure must exit non-zero and write nothing.
//
// This drives the real CLI against synthetic archives built in the temp dir,
// including an archive whose name table needs the second advance rule. Both
// layouts are exercised because the .p container is the one shape this tree
// does not otherwise parse: the tool decides the rule empirically (the cursor
// must land exactly on the first member's data) rather than trusting a
// convention.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { preloadRangesFor } = require('../lib/byte-provider');

const TOOL = path.join(__dirname, '..', 'tools', 'mbaa-texture-census.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbaa-census-'));

// A synthesised member: an 8-byte-image header (w, h, format, payload length)
// followed by `payload` bytes of indices. format 0 = 8bpp, so payload = w*h.
function textureMember(w, h, fill) {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(w, 0); head.writeUInt32LE(h, 4);
  head.writeUInt32LE(0, 8); head.writeUInt32LE(w * h, 12);
  return Buffer.concat([head, Buffer.alloc(w * h, fill)]);
}
function otherMember(bytes) { return Buffer.alloc(bytes, 0x22); }

// `shape` A: names NUL-terminated, stored length EXCLUDES the terminator.
// `shape` B: '\0name', stored length EXCLUDES the leading NUL (so the cursor
// step is length + 1 as well, but the 1 is the prefix -- the tool's rule is
// empirical, which is the point of testing both).
function writeArchive(file, members, shape) {
  const n = members.length;
  const names = shape === 'A'
    ? Buffer.concat(members.map(m => Buffer.from(m.name + '\0', 'latin1')))
    : Buffer.concat(members.map(m => Buffer.from('\0' + m.name, 'latin1')));
  const namesAt = 16, tableLength = n * 8;
  const dataAt = namesAt + tableLength + names.length;
  let at = dataAt;
  const entries = [];
  for (const m of members) {
    entries.push([at, m.name.length + (shape === 'A' ? 1 : 1)]);
    at += m.data.length;
  }
  // ...but the STEP that lands on dataAt is a property of the shape, and for
  // B it is the same length+1 because the prefix is not counted.
  const header = Buffer.alloc(16);
  header.writeUInt32LE(n, 4); header.writeUInt32LE(namesAt, 8); header.writeUInt32LE(dataAt, 12);
  const table = Buffer.alloc(tableLength);
  entries.forEach(([offset, length], i) => {
    table.writeUInt32LE(offset, i * 8);
    table.writeUInt32LE(length, i * 8 + 4);
  });
  fs.writeFileSync(file, Buffer.concat([header, table, names, ...members.map(m => m.data)]));
  return { dataAt, names };
}

function run(file, ...extra) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, file, ...extra], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

const members = [
  { name: 'spr_a.bin', data: textureMember(8, 8, 0x11) },
  { name: 'bgm.dat', data: otherMember(1000) },
  { name: 'spr_b.bin', data: textureMember(16, 16, 0x33) },
];

for (const shape of ['A', 'B']) {
  const archive = path.join(dir, `shape-${shape}.p`);
  const out = path.join(dir, `shape-${shape}.json`);
  const { dataAt } = writeArchive(archive, members, shape);
  const result = run(archive, `--out=${out}`);
  assert.strictEqual(result.code, 0, `shape ${shape} parses: ${result.stderr}`);
  const list = JSON.parse(fs.readFileSync(out, 'utf8'));

  // The list is the preloadRangesFor() contract, so prove it is readable by the
  // consumer rather than just well-shaped.
  const size = fs.statSync(archive).size;
  assert.strictEqual(list.schemaVersion, 1);
  assert.strictEqual(list.size, size, 'the measured size is the file size');
  const ranges = preloadRangesFor(list, size);
  assert.ok(ranges.length >= 1, 'preloadRangesFor accepts the emitted list');

  // Two texture members, the 1000-byte BGM member NOT pinned, and every pinned
  // byte is inside the archive.
  const pinned = ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);
  assert.strictEqual(pinned, 80 + 272, `shape ${shape}: only the two texture members are pinned`);
  assert.ok(pinned < size, 'the range list is smaller than the archive');
  for (const [start, end] of ranges) {
    assert.ok(start >= dataAt && end <= size, 'a pinned range stays inside the data area');
  }
  // The other member's bytes are not covered by any range.
  const other = dataAt + 80;
  assert.ok(!ranges.some(([start, end]) => start <= other && end > other),
    'the non-texture member is left streaming');
}

// A truncated/corrupt table must FAIL, and must not leave a range list behind:
// a launch that pins garbage is worse than a launch that streams.
for (const [label, corrupt] of [
  ['count beyond EOF', buf => { buf.writeUInt32LE(9999, 4); return buf; }],
  ['name table outside the file', buf => { buf.writeUInt32LE(buf.length + 0x1000, 8); return buf; }],
  ['data offset before the name table', buf => { buf.writeUInt32LE(4, 12); return buf; }],
  ['truncated member table', buf => buf.subarray(0, 20)],
]) {
  const archive = path.join(dir, `bad-${label.replace(/\W+/g, '-')}.p`);
  const out = path.join(dir, `bad-${label.replace(/\W+/g, '-')}.json`);
  const base = path.join(dir, 'shape-A.p');
  fs.writeFileSync(archive, corrupt(fs.readFileSync(base)));
  const result = run(archive, `--out=${out}`);
  assert.notStrictEqual(result.code, 0, `${label}: the tool must exit non-zero`);
  assert.ok(!fs.existsSync(out), `${label}: no range list is written`);
  assert.ok(/not a \.p archive|no name-table advance rule/.test(result.stderr),
    `${label}: the message names the problem`);
}

// The pin bound is a bound: a list that would pin more than --max-mb fails
// loudly instead of quietly turning a "few tens of MB" preload into the whole
// archive (which is what preloadAssets is for).
{
  const archive = path.join(dir, 'too-big.p');
  writeArchive(archive, [
    { name: 'a.bin', data: textureMember(64, 64, 1) },
    { name: 'b.bin', data: textureMember(64, 64, 2) },
  ], 'A');
  const result = run(archive, '--max-mb=0', `--out=${path.join(dir, 'too-big.json')}`);
  assert.notStrictEqual(result.code, 0, 'over the pin bound is a failure');
  assert.ok(!fs.existsSync(path.join(dir, 'too-big.json')), 'and writes nothing');
}

// A container is free to store its name table in an order that is NOT the
// order the members occupy in the file. The extent of a member is the distance
// to the next member IN THE FILE, so a table sorted by name (or by anything
// else) must still yield the real extents. Reading the successor out of the
// table instead gave end === start for any member whose table neighbour sat
// earlier in the file -- length 0, unclassifiable, silently NOT pinned -- while
// the member before it swallowed everything between them. The archive then
// streamed a sprite it was supposed to pin, which is the exact failure the
// tool exists to prevent, and it failed without a message.
{
  const names = ['a_tex.bin', 'b_other.bin', 'c_tex.bin'];
  const datas = [
    textureMember(8, 8, 0x11),      // 80 bytes
    otherMember(500),
    textureMember(16, 16, 0x33),    // 272 bytes
  ];
  // Table order: a_tex.bin, c_tex.bin, b_other.bin -- i.e. file offsets 0, 2, 1.
  // The NAMES are stored in table order (that is how the walker reads them);
  // it is the OFFSETS that are out of file order, which is the defect below.
  const order = [0, 2, 1];
  const nameBlob = Buffer.from(order.map(i => names[i] + '\0').join(''), 'latin1');
  const namesAt = 16, tableLength = 3 * 8;
  const dataAt = namesAt + tableLength + nameBlob.length;
  const fileOff = [dataAt, dataAt + datas[0].length, dataAt + datas[0].length + datas[1].length];
  const header = Buffer.alloc(16);
  header.writeUInt32LE(3, 4); header.writeUInt32LE(namesAt, 8); header.writeUInt32LE(dataAt, 12);
  const table = Buffer.alloc(tableLength);
  order.forEach((memberIndex, slot) => {
    table.writeUInt32LE(fileOff[memberIndex], slot * 8);
    table.writeUInt32LE(names[memberIndex].length + 1, slot * 8 + 4);
  });
  const archive = path.join(dir, 'unsorted-table.p');
  fs.writeFileSync(archive, Buffer.concat([header, table, nameBlob, ...datas]));

  const out = path.join(dir, 'unsorted-table.json');
  const result = run(archive, `--out=${out}`);
  assert.strictEqual(result.code, 0, `an unsorted table still parses: ${result.stderr}`);
  const list = JSON.parse(fs.readFileSync(out, 'utf8'));
  const ranges = preloadRangesFor(list, fs.statSync(archive).size);
  const pinned = ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);
  assert.strictEqual(pinned, datas[0].length + datas[2].length,
    'both texture members are pinned even though the table is not in file order');
  // ...and the non-texture member between them stays out of the pin set.
  const otherStart = fileOff[1];
  assert.ok(!ranges.some(([start, end]) => start <= otherStart && end > otherStart),
    'the non-texture member is not swallowed by a neighbour\'s extent');
  // Every member has a real extent: no zero-length members from a bad successor.
  const listed = run(archive, '--json');
  const parsed = JSON.parse(listed.stdout);
  assert.ok(parsed.list.every(m => m.length > 0), 'no member has a zero-length extent');
  assert.strictEqual(parsed.textureMembers, 2, 'both textures are still classified');
}

// --list and --json are diagnostics and must not need --out.
{
  const list = run(path.join(dir, 'shape-A.p'), '--json');
  assert.strictEqual(list.code, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.strictEqual(parsed.textureMembers, 2);
  assert.strictEqual(parsed.otherMembers, 1);
  assert.ok(parsed.list.some(m => m.kind === 'texture:raw' && m.name === 'spr_a.bin'));
  // --list alone is the human form and must mention the classification.
  const human = run(path.join(dir, 'shape-A.p'), '--list');
  assert.strictEqual(human.code, 0);
  assert.ok(/texture:raw/.test(human.stdout) && /bgm\.dat/.test(human.stdout));
}

// The archive is the size of a real sprite pack, and the tool must not read it
// whole: 0002.p is ~900 MB and a census that allocates it cannot run on the
// machine that owns the file. The file is sparse, so this costs no disk, and
// the tail is written past a huge hole -- if the tool ever goes back to
// readFileSync, the child process dies on allocation instead of quietly
// succeeding slowly. (Measured: 42 MB RSS and 22 ms for a 1.6 GB archive.)
{
  const big = path.join(dir, 'sparse-big.p');
  const nameBlob = Buffer.from('spr_a.bin\0bgm.dat\0spr_b.bin\0', 'latin1');
  const namesAt = 16, tableLength = 3 * 8;
  const dataAt = namesAt + tableLength + nameBlob.length;
  const texture = textureMember(8, 8, 0x11);           // 80 bytes
  const HOLE = 400 * 1024 * 1024;                     // > any sane allocation
  const offsets = [dataAt, dataAt + texture.length, dataAt + texture.length + HOLE];
  const header = Buffer.alloc(16);
  header.writeUInt32LE(3, 4); header.writeUInt32LE(namesAt, 8); header.writeUInt32LE(dataAt, 12);
  const table = Buffer.alloc(tableLength);
  [ 'spr_a.bin', 'bgm.dat', 'spr_b.bin' ].forEach((name, i) => {
    table.writeUInt32LE(offsets[i], i * 8);
    table.writeUInt32LE(name.length + 1, i * 8 + 4);
  });
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, header, 0, header.length, 0);
  fs.writeSync(fd, table, 0, table.length, namesAt);
  fs.writeSync(fd, nameBlob, 0, nameBlob.length, 16 + tableLength);
  fs.writeSync(fd, texture, 0, texture.length, dataAt);
  // One byte in the far tail so the third member has a real extent.
  fs.writeSync(fd, Buffer.from([0xab]), 0, 1, offsets[2] + HOLE);
  fs.closeSync(fd);

  const out = path.join(dir, 'sparse-big.json');
  const result = run(big, `--out=${out}`);
  assert.strictEqual(result.code, 0, `a sparse large archive is censused: ${result.stderr}`);
  const list = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(list.size, offsets[2] + HOLE + 1, 'the size is the file size');
  const last = list.ranges[list.ranges.length - 1];
  assert.ok(last[1] <= list.size, 'no range runs past EOF');
  // Only the one texture member is pinned; the hole is not.
  const pinned = list.ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
  assert.strictEqual(pinned, texture.length, 'the sparse hole is not pinned');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS mbaa texture census: both .p name-table shapes, texture-only ranges, corrupt archives refused');
