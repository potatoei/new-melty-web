#!/usr/bin/env node
'use strict';

// Pack assets into the seekable MBCZ container that lib/compressed-provider.js
// reads: fixed-size blocks, each deflated independently, plus an index -- so
// any byte range costs only the blocks it overlaps.
//
//   node tools/compress-assets.js <dir> --out=<dir> [--block-size=262144]
//        [--only=0002.p,0003.p] [--manifest=FILE] [--level=9]
//        [--verify] [--keep-names] [--json]
//
// WHY NOT gzip THE WHOLE FILE
//
// Measured on this project's own data shape: whole-file gzip/brotli reach a
// better ratio than block-deflate (a long window amortises repeated sprite
// headers across the whole archive), and they are useless here, because the
// engine reads by HTTP byte range. To answer `readRange(500MB, 1MB)` from a
// whole-file gzip you must inflate 500MB first. Blocks trade a few percent of
// ratio for O(blockSize) access, which is the only property that matters.
//
// The container keeps the ORIGINAL file name in the manifest and the provider
// presents the ORIGINAL size, so the guest -- and the VFS, and preloadRanges --
// see an uncompressed file of the original length. Nothing above the provider
// knows the bytes on the wire are compressed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = 0x5a43424d;          // 'MBCZ'
const VERSION = 1;
const CODEC_DEFLATE = 1;
const HEADER_BYTES = 32;
const INDEX_ENTRY_BYTES = 16;
const FLAG_STORED = 1;

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crc32.table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function usage() {
  console.error('usage: compress-assets.js <dir> --out=<dir> [--block-size=262144] ' +
    '[--only=a.p,b.p] [--manifest=FILE] [--level=9] [--verify] [--json]');
  process.exit(2);
}

const args = process.argv.slice(2);
const dirArg = args.find(a => !a.startsWith('--'));
if (!dirArg) usage();
const outArg = (args.find(a => a.startsWith('--out=')) || '').slice(6);
const manifestArg = (args.find(a => a.startsWith('--manifest=')) || '').slice(11);
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const blockArg = args.find(a => a.startsWith('--block-size='));
const levelArg = args.find(a => a.startsWith('--level='));
const JSON_OUT = args.includes('--json');
const VERIFY = args.includes('--verify');

// 256KB blocks: a 1MB read touches 4-5 of them, and a 2.1GB archive indexes to
// ~8,200 entries (131KB) -- small enough to load before the first read.
let blockSize = 256 * 1024;
if (blockArg) {
  blockSize = Number(blockArg.slice(13));
  if (!Number.isSafeInteger(blockSize) || blockSize < 4096 || blockSize > 8 * 1024 * 1024) {
    console.error(`compress-assets: --block-size must be 4096..8388608 (got ${blockArg})`);
    process.exit(2);
  }
}
let level = 9;
if (levelArg) {
  level = Number(levelArg.slice(8));
  if (!Number.isInteger(level) || level < 1 || level > 9) {
    console.error(`compress-assets: --level must be 1..9 (got ${levelArg})`);
    process.exit(2);
  }
}
if (!outArg) usage();

const ASSET_EXTENSIONS = new Set([
  '.p', '.bin', '.dat', '.exe', '.dll', '.wav', '.mp3', '.ogg', '.avi', '.bmp',
  '.png', '.jpg', '.jpeg', '.ttf', '.otf', '.pak', '.idx',
]);

// Container name: the original name plus `.mbcz`. The provider presents the
// original size, and the app manifest points `url` at this file while keeping
// the original `size`, so nothing downstream sees the compressed length.
function containerName(name) { return `${name}.mbcz`; }

function packFile(filePath, name, outDir) {
  const original = fs.readFileSync(filePath);
  const originalSize = original.length;
  const blockCount = Math.ceil(originalSize / blockSize) || 0;
  if (!blockCount) throw new Error(`${name}: empty file cannot be packed`);

  const blocks = [];
  const payloads = [];
  let payloadBytes = HEADER_BYTES;
  for (let index = 0; index < blockCount; index++) {
    const start = index * blockSize;
    const end = Math.min(originalSize, start + blockSize);
    const raw = original.subarray(start, end);
    const deflated = zlib.deflateRawSync(raw, { level });
    // A block that does not pay for itself is stored, flagged, so an already
    // compressed asset (mp3, png) cannot grow by a few bytes per block.
    const useStored = deflated.length >= raw.length;
    const bytes = useStored ? raw : deflated;
    blocks.push({
      index,
      offset: payloadBytes,
      compressedLength: bytes.length,
      originalLength: raw.length,
      stored: useStored,
    });
    payloads.push(bytes);
    payloadBytes += bytes.length;
  }

  const indexOffset = payloadBytes;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(CODEC_DEFLATE, 6);
  header.writeUInt32LE(blockSize, 8);
  header.writeUInt32LE(blockCount, 12);
  header.writeUInt32LE(originalSize % 0x100000000, 16);
  header.writeUInt32LE(Math.floor(originalSize / 0x100000000), 20);
  header.writeUInt32LE(indexOffset, 24);
  header.writeUInt32LE(crc32(header.subarray(0, 28)), 28);

  const index = Buffer.alloc(blockCount * INDEX_ENTRY_BYTES);
  blocks.forEach((block, i) => {
    const base = i * INDEX_ENTRY_BYTES;
    index.writeUInt32LE(block.offset, base);
    index.writeUInt32LE(block.compressedLength, base + 4);
    index.writeUInt32LE(block.originalLength, base + 8);
    index.writeUInt32LE(block.stored ? FLAG_STORED : 0, base + 12);
  });

  const outPath = path.join(outDir, containerName(name));
  const fd = fs.openSync(outPath, 'w');
  try {
    // EVERY write is positioned. A positioned write does NOT advance the fd's
    // internal file offset, so mixing it with an unpositioned write puts the
    // next write at offset 0 -- which silently overwrote the header with the
    // first payload block and produced a container whose first 32 bytes were
    // asset data. Track the offset explicitly instead.
    let at = 0;
    at += fs.writeSync(fd, header, 0, header.length, at);
    for (const bytes of payloads) at += fs.writeSync(fd, bytes, 0, bytes.length, at);
    fs.writeSync(fd, index, 0, index.length, at);
  } finally {
    fs.closeSync(fd);
  }

  const containerSize = fs.statSync(outPath).size;
  return {
    name,
    container: containerName(name),
    path: outPath,
    originalSize,
    containerSize,
    blockSize,
    blockCount,
    storedBlocks: blocks.filter(b => b.stored).length,
    sha256: crypto.createHash('sha256').update(original).digest('hex'),
    containerSha256: crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex'),
    ratio: originalSize ? containerSize / originalSize : 1,
  };
}

// Re-inflate every block through the SAME parser the browser uses, and compare
// the reassembled bytes with the source. Compression is only safe if this
// passes: a container that decompresses to the wrong bytes is a silently
// corrupt asset, which is the worst failure mode this project has (a texture
// that is resident but wrong).
async function verifyContainer(record, sourceDir) {
  const { CompressedProvider } = require('../lib/compressed-provider');
  const bytes = fs.readFileSync(record.path);
  const provider = {
    name: record.container,
    size: bytes.length,
    readRangeSync: (off, len) => bytes.subarray(off, Math.min(bytes.length, off + len)),
    readRange: async (off, len) => bytes.subarray(off, Math.min(bytes.length, off + len)),
  };
  const wrapped = await CompressedProvider.open(provider, { name: record.name });
  if (wrapped.size !== record.originalSize) {
    return { ok: false, reason: `provider size ${wrapped.size} != original ${record.originalSize}` };
  }
  const original = fs.readFileSync(path.join(sourceDir, record.name));
  // Read the whole thing in 1MB reads, which is what ChunkCache does, plus a
  // few deliberately unaligned ranges so a straddling block is exercised.
  const rebuilt = new Uint8Array(wrapped.size);
  for (let at = 0; at < wrapped.size; at += 1024 * 1024) {
    const len = Math.min(1024 * 1024, wrapped.size - at);
    rebuilt.set(await wrapped.readRange(at, len), at);
  }
  if (Buffer.compare(Buffer.from(rebuilt), original) !== 0) {
    return { ok: false, reason: 'rebuilt bytes differ from the source' };
  }
  for (const [off, len] of [[0, 1], [1, 3], [record.blockSize - 1, 2], [record.blockSize, 1],
    [Math.max(0, wrapped.size - 7), 7]]) {
    const slice = await wrapped.readRange(off, len);
    const want = original.subarray(off, Math.min(original.length, off + len));
    if (Buffer.compare(Buffer.from(slice), want) !== 0) {
      return { ok: false, reason: `unaligned range @${off}+${len} differs` };
    }
  }
  return { ok: true };
}

(async () => {
  const sourceDir = path.resolve(dirArg);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(`compress-assets: ${sourceDir} is not a directory`);
    process.exit(2);
  }
  let names = fs.readdirSync(sourceDir)
    .filter(name => ASSET_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .filter(name => !/\.(mbcz|part\d{3})$/.test(name))
    .sort();
  if (onlyArg) {
    const wanted = onlyArg.split(',').map(s => s.trim()).filter(Boolean);
    const missing = wanted.filter(name => !names.includes(name));
    if (missing.length) {
      console.error(`compress-assets: --only names ${missing.join(', ')} but the directory has no such file`);
      process.exit(1);
    }
    names = names.filter(name => wanted.includes(name));
  }
  if (!names.length) {
    console.error(`compress-assets: no assets in ${sourceDir}`);
    process.exit(1);
  }
  fs.mkdirSync(outArg, { recursive: true });

  const records = [];
  for (const name of names) records.push(packFile(path.join(sourceDir, name), name, outArg));

  let failed = 0;
  if (VERIFY) {
    for (const record of records) {
      const result = await verifyContainer(record, sourceDir);
      if (!result.ok) { failed++; console.error(`FAIL ${record.name}: ${result.reason}`); }
    }
  }

  const totalOriginal = records.reduce((n, r) => n + r.originalSize, 0);
  const totalContainer = records.reduce((n, r) => n + r.containerSize, 0);
  const manifest = {
    schemaVersion: 1,
    container: 'MBCZ',
    version: VERSION,
    codec: 'deflate-raw',
    blockSize,
    level,
    files: records.map(r => ({
      name: r.name,
      container: r.container,
      originalSize: r.originalSize,
      containerSize: r.containerSize,
      blockSize: r.blockSize,
      blockCount: r.blockCount,
      storedBlocks: r.storedBlocks,
      sha256: r.sha256,
      containerSha256: r.containerSha256,
    })),
    totals: {
      files: records.length,
      originalBytes: totalOriginal,
      containerBytes: totalContainer,
      ratio: totalOriginal ? totalContainer / totalOriginal : 1,
    },
  };

  // Bytes for a small file, MB for a large one: a 33-byte file printed as
  // "0.0MB -> 0.0MB (-145.5% smaller)" is worse than useless, and a negative
  // percentage reads as a bug in the tool rather than as the header overhead it
  // actually is.
  const size = n => (n >= 1024 * 1024
    ? `${(n / 1048576).toFixed(1)}MB`
    : `${n}B`);
  const verdict = (original, container) => {
    const saved = original - container;
    return saved >= 0
      ? `${((saved / original) * 100).toFixed(1)}% smaller`
      : `${size(-saved)} LARGER (header overhead on a tiny file)`;
  };
  if (!JSON_OUT) {
    for (const r of records) {
      console.log(`${r.name}: ${size(r.originalSize)} -> ${size(r.containerSize)} ` +
        `(${verdict(r.originalSize, r.containerSize)}, ${r.blockCount} blocks, ` +
        `${r.storedBlocks} stored)`);
    }
    console.log(`total: ${size(totalOriginal)} -> ${size(totalContainer)} ` +
      `(${verdict(totalOriginal, totalContainer)})`);
    if (VERIFY) console.log(failed ? `${failed} file(s) FAILED verification` : 'all files verified byte-for-byte');
  }
  if (manifestArg) {
    fs.writeFileSync(manifestArg, JSON.stringify(manifest, null, 2) + '\n');
    if (!JSON_OUT) console.log(`wrote ${manifestArg}`);
  }
  if (JSON_OUT) console.log(JSON.stringify(manifest, null, 2));
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(`compress-assets: ${error.message}`);
  process.exit(1);
});
