#!/usr/bin/env node
'use strict';

// lib/compressed-provider.js + tools/compress-assets.js: a block-compressed
// container must be indistinguishable from the original file to every layer
// above the provider.
//
// That indirection is the entire risk. The guest, the VFS, ChunkCache and
// preloadRanges all believe they are reading `0002.p` at its real size; if the
// provider is off by one byte, or inflates a block at the wrong offset, or
// reports the container's size instead of the original, the guest gets
// plausible garbage. A texture that is resident but wrong is the worst failure
// this project has, because the game caches it.
//
// So this drives the real packer and the real provider through the real
// ChunkCache the host mounts, and compares every byte.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const byteProvider = require('../lib/byte-provider');
const compressed = require('../lib/compressed-provider');

const TOOL = path.join(__dirname, '..', 'tools', 'compress-assets.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbcz-'));
const src = path.join(dir, 'src');
const out = path.join(dir, 'out');
fs.mkdirSync(src);

function run(args) {
  return execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
}

// Three shapes: a multi-block file with mixed compressibility, a file that is
// not a block multiple, and a file smaller than one block (which must still
// round-trip, header overhead or not).
function buildFixtures(blockSize) {
  const parts = [];
  for (let i = 0; i < 12; i++) {
    const w = 64, h = 64, head = Buffer.alloc(16);
    head.writeUInt32LE(w, 0); head.writeUInt32LE(h, 4);
    head.writeUInt32LE(0, 8); head.writeUInt32LE(w * h, 12);
    const px = Buffer.alloc(w * h);
    for (let j = 0; j < px.length; j++) {
      const x = j % w, y = (j / w) | 0;
      px[j] = (x < 4 || y < 4 || x > w - 5 || y > h - 5) ? 0 : ((j * 7 + i) & 0xff);
    }
    parts.push(head, px, Buffer.alloc(1024, 0x20));
  }
  // Incompressible bytes: the packer must STORE these blocks, not grow them.
  // These have to be REAL entropy -- a linear counter mod 256 has a period of
  // 256 and deflate eats it, which is exactly the mistake that made this
  // assertion fail against a correct packer.
  parts.push(require('crypto').randomBytes(200 * 1024));
  parts.push(Buffer.from('repeating script text. '.repeat(1500)));
  const big = Buffer.concat(parts);
  fs.writeFileSync(path.join(src, '0002.p'), big);
  // Deliberately not a block multiple, and offsets that straddle blocks.
  fs.writeFileSync(path.join(src, '0003.p'), big.subarray(0, blockSize * 2 + 61));
  fs.writeFileSync(path.join(src, 'small.dat'), Buffer.from('one short file'));
  return { big, odd: blockSize * 2 + 61 };
}

function providerOver(bytes) {
  return {
    name: 'container',
    size: bytes.length,
    readRangeSync: (off, len) => bytes.subarray(off, Math.min(bytes.length, off + len)),
    readRange: async (off, len) => new Uint8Array(bytes.subarray(off, Math.min(bytes.length, off + len))),
  };
}

(async () => {
  const BLOCK = 32 * 1024;
  const names = { ...buildFixtures(BLOCK) };
  run([src, `--out=${out}`, `--block-size=${BLOCK}`, `--manifest=${path.join(dir, 'compress.json')}`, '--verify']);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'compress.json'), 'utf8'));

  // The recorded original size is the size the guest must see.
  for (const record of manifest.files) {
    assert.strictEqual(record.originalSize, fs.statSync(path.join(src, record.name)).size,
      `${record.name}: the manifest records the original size`);
  }

  for (const name of ['0002.p', '0003.p', 'small.dat']) {
    const original = fs.readFileSync(path.join(src, name));
    const container = fs.readFileSync(path.join(out, `${name}.mbcz`));
    const provider = await compressed.CompressedProvider.open(providerOver(container), { name });
    assert.strictEqual(provider.size, original.length,
      `${name}: the provider reports the ORIGINAL size, not the container's`);

    // Through the same cache the host mounts (host.js: cached(provider, {maxChunks:4096})).
    const cache = byteProvider.cached(provider, { maxChunks: 4096 });

    // Sequential 1MB reads: the VFS pattern for a large archive.
    const rebuilt = new Uint8Array(provider.size);
    for (let at = 0; at < provider.size; at += 1024 * 1024) {
      const len = Math.min(1024 * 1024, provider.size - at);
      rebuilt.set(await cache.readRange(at, len), at);
    }
    assert.deepStrictEqual(Buffer.from(rebuilt), original, `${name}: sequential reads rebuild byte-for-byte`);

    // Unaligned reads at block boundaries, which is where an off-by-one shows.
    const edges = [0, 1, BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK - 1, 2 * BLOCK, provider.size - 2];
    for (const off of edges) {
      for (const len of [1, 2, 3, 17, BLOCK - 1]) {
        if (off < 0 || off + len > provider.size) continue;
        const got = await cache.readRange(off, len);
        assert.deepStrictEqual(Buffer.from(got), original.subarray(off, off + len),
          `${name}: @${off}+${len} matches`);
      }
    }

    // Past EOF is clamped, never an over-read.
    const tail = await cache.readRange(provider.size - 3, 100);
    assert.deepStrictEqual(Buffer.from(tail), original.subarray(original.length - 3),
      `${name}: a read past EOF is clamped to the real bytes`);

    // The synchronous path must agree with the asynchronous one; the VFS uses
    // it wherever the whole path can stay synchronous.
    const sync = cache.readRangeSync(0, Math.min(100, provider.size));
    assert.deepStrictEqual(Buffer.from(sync), original.subarray(0, sync.length),
      `${name}: readRangeSync matches readRange`);
  }

  // A block that did not compress is stored and flagged, so an already-packed
  // asset cannot grow by a few bytes per block.
  const bigRecord = manifest.files.find(f => f.name === '0002.p');
  assert.ok(bigRecord.storedBlocks > 0,
    'the incompressible region is stored rather than deflated larger');

  // Corruption must be REFUSED, never served. Each of these would otherwise
  // hand the guest plausible bytes at the wrong offsets.
  const good = fs.readFileSync(path.join(out, '0002.p.mbcz'));
  const corruptions = [
    ['bad magic', buf => { buf.writeUInt32LE(0xdeadbeef, 0); return buf; }],
    ['header CRC', buf => { buf[20] ^= 0xff; return buf; }],
    ['truncated', buf => buf.subarray(0, 40)],
    ['index offset', buf => { buf.writeUInt32LE(buf.length + 4096, 24); return buf; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const broken = corrupt(Buffer.from(good));
    let refused = false;
    try {
      await compressed.CompressedProvider.open(providerOver(broken), { name: 'x' });
    } catch (_) {
      refused = true;
    }
    assert.ok(refused, `${label}: the provider refuses to mount`);
  }

  // A block whose inflated length disagrees with the index is refused at read
  // time rather than returned short or padded.
  {
    const provider = await compressed.CompressedProvider.open(providerOver(Buffer.from(good)), { name: 'x' });
    provider.entries[0] = { ...provider.entries[0], originalLength: provider.entries[0].originalLength + 1 };
    let refused = false;
    try {
      await provider.readRange(0, 16);
    } catch (_) {
      refused = true;
    }
    assert.ok(refused, 'an inflated-length mismatch is refused, not served');
  }

  // The packer's own --verify round-trips through the same parser, so a bad
  // container is caught at pack time rather than in a browser.
  const verified = run([src, `--out=${path.join(dir, 'out2')}`, `--block-size=${BLOCK}`, '--verify']);
  assert.ok(/verified byte-for-byte/.test(verified), 'the packer verifies what it wrote');

  console.log('PASS compressed assets: seekable container round-trips byte-for-byte ' +
    'through ChunkCache, sync and async, and refuses corruption');
})().catch(error => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
