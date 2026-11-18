// Seekable-compressed byte provider: a block-compressed container served
// through the same interface as HttpRangeProvider, so the guest reads the
// ORIGINAL bytes and never learns the file is compressed.
//
// WHY A CONTAINER AND NOT gzip
//
// gzip/zstd on the whole file is not seekable: to answer `readRange(500_000_000,
// 1MB)` you must inflate 500 MB first. The engine reads archives by byte range
// exactly that way (lib/byte-provider.js HttpRangeProvider + ChunkCache), so a
// whole-file codec would turn every read into a full decompression. This splits
// the file into fixed-size blocks, compresses each independently, and keeps an
// index -- so any range costs only the blocks it overlaps.
//
// The layer above (ChunkCache) caches 1MB chunks; this provider caches a small
// number of inflated blocks so a 1MB chunk straddling two blocks does not
// re-inflate on the next read. Both caches bound memory independently.
//
// FORMAT (little endian, 32-byte header)
//
//   0   'M' 'B' 'C' 'Z'
//   4   u16 version = 1
//   6   u16 codec   = 1 (deflate-raw)
//   8   u32 blockSize
//   12  u32 blockCount
//   16  u32 originalSizeLow
//   20  u32 originalSizeHigh
//   24  u32 indexOffset
//   28  u32 headerCrc32  (over bytes 0..27, this field excluded)
//   32  block data, then the index at indexOffset
//
// Each index entry is 16 bytes:
//   u32 compressedOffset (from file start), u32 compressedLength,
//   u32 originalLength, u32 flags (0 = deflate-raw, 1 = stored)
//
// A block that does not compress is STORED and flagged, so incompressible
// assets do not grow. Every block is independent; one corrupt block cannot
// silently shift the bytes of another, because both its lengths are in the
// index and are checked against what inflates.
(function () {
  'use strict';

  const MAGIC = 0x5a43424d;          // 'MBCZ' little endian
  const VERSION = 1;
  const CODEC_DEFLATE = 1;
  const HEADER_BYTES = 32;
  const INDEX_ENTRY_BYTES = 16;
  const FLAG_STORED = 1;

  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  let nodeZlib = null;
  if (isNode) {
    try { nodeZlib = require('zlib'); } catch (_) { nodeZlib = null; }
  }

  function crc32(bytes) {
    // Small table-based CRC-32, computed once. Only the 28-byte header uses it;
    // block integrity is checked by comparing inflated length to the index.
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
    for (let i = 0; i < bytes.length; i++) {
      crc = crc32.table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function inflateRawSync(bytes) {
    if (!nodeZlib) return null;
    const out = nodeZlib.inflateRawSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  }

  async function inflateRawAsync(bytes) {
    const sync = inflateRawSync(bytes);
    if (sync) return sync;
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('compressed-provider: no zlib and no DecompressionStream to inflate with');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function clampRange(size, off, len) {
    let start = Number(off) | 0;
    let end = start + (Number(len) | 0);
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end < start) end = start;
    if (start > size) start = size;
    if (end > size) end = size;
    return { start, end, len: end - start };
  }

  // Parse the 32-byte header. Throws on anything that does not describe a
  // container: a wrong parse here would hand the guest bytes at the wrong
  // offsets, which is worse than refusing to mount.
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_BYTES) {
      throw new Error('compressed container: shorter than a header');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC) {
      throw new Error('compressed container: bad magic (not an MBCZ container)');
    }
    const version = view.getUint16(4, true);
    if (version !== VERSION) throw new Error(`compressed container: unsupported version ${version}`);
    const codec = view.getUint16(6, true);
    if (codec !== CODEC_DEFLATE) throw new Error(`compressed container: unsupported codec ${codec}`);
    const blockSize = view.getUint32(8, true);
    const blockCount = view.getUint32(12, true);
    const originalSizeLow = view.getUint32(16, true);
    const originalSizeHigh = view.getUint32(20, true);
    const indexOffset = view.getUint32(24, true);
    const headerCrc = view.getUint32(28, true);
    const expected = crc32(bytes.subarray(0, 28));
    if (headerCrc !== expected) {
      throw new Error('compressed container: header CRC mismatch (truncated or corrupt)');
    }
    if (!blockSize || !blockCount) throw new Error('compressed container: empty block table');
    const originalSize = originalSizeHigh * 0x100000000 + originalSizeLow;
    if (blockCount !== Math.ceil(originalSize / blockSize)) {
      throw new Error(`compressed container: block count ${blockCount} disagrees with ` +
        `${originalSize} bytes in ${blockSize}-byte blocks`);
    }
    return { blockSize, blockCount, originalSize, indexOffset, codec, version };
  }

  function parseIndex(bytes, header) {
    const need = header.blockCount * INDEX_ENTRY_BYTES;
    if (bytes.length !== need) {
      throw new Error(`compressed container: index is ${bytes.length} bytes, expected ${need}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Array(header.blockCount);
    let expectedOffset = HEADER_BYTES;
    let originalTotal = 0;
    for (let i = 0; i < header.blockCount; i++) {
      const base = i * INDEX_ENTRY_BYTES;
      const entry = {
        index: i,
        offset: view.getUint32(base, true),
        compressedLength: view.getUint32(base + 4, true),
        originalLength: view.getUint32(base + 8, true),
        stored: (view.getUint32(base + 12, true) & FLAG_STORED) === FLAG_STORED,
      };
      // Blocks are written back to back from the end of the header. Proving it
      // here means a garbage index is refused at mount instead of being read as
      // plausible offsets into unrelated bytes.
      if (entry.offset !== expectedOffset) {
        throw new Error(`compressed container: block ${i} starts at ${entry.offset}, ` +
          `expected ${expectedOffset}`);
      }
      if (!entry.compressedLength || !entry.originalLength) {
        throw new Error(`compressed container: block ${i} has a zero length`);
      }
      if (entry.stored ? entry.compressedLength !== entry.originalLength : entry.compressedLength >= entry.originalLength) {
        throw new Error(`compressed container: block ${i} store/deflate flag disagrees with its lengths`);
      }
      expectedOffset += entry.compressedLength;
      originalTotal += entry.originalLength;
      entries[i] = entry;
    }
    if (originalTotal !== header.originalSize) {
      throw new Error(`compressed container: blocks total ${originalTotal} bytes, header says ${header.originalSize}`);
    }
    if (expectedOffset !== header.indexOffset) {
      throw new Error(`compressed container: data ends at ${expectedOffset}, index at ${header.indexOffset}`);
    }
    return entries;
  }

  // The provider. `underlying` is anything provider-shaped over the COMPRESSED
  // container bytes -- an HttpRangeProvider, a ConcatProvider over .partNNN, a
  // BlobProvider. `size` is the ORIGINAL size, which is what every consumer
  // above this layer must see.
  class CompressedProvider {
    constructor(underlying, header, entries, options) {
      const opts = options || {};
      this.underlying = underlying;
      this.header = header;
      this.entries = entries;
      this.size = header.originalSize;
      this.blockSize = header.blockSize;
      this.name = opts.name || underlying.name || '<compressed>';
      // Inflated blocks, most-recent last. Bounded because the layer above
      // already caches; this only exists to stop a straddling read from
      // inflating the same block twice in a row.
      this._blockCache = new Map();
      this._maxBlocks = opts.maxBlocks === undefined ? 8 : opts.maxBlocks;
      this.stats = { blocksInflated: 0, inflateBytes: 0, cacheHits: 0 };
    }

    // Read the index once, lazily: a mount costs one header read, and a file the
    // guest never opens costs nothing more.
    static async open(underlying, options) {
      if (!underlying || typeof underlying.readRange !== 'function') {
        throw new Error('CompressedProvider.open: an underlying provider is required');
      }
      if (!Number.isSafeInteger(underlying.size) || underlying.size < HEADER_BYTES) {
        throw new Error('CompressedProvider.open: underlying size is not a container');
      }
      const head = new Uint8Array(await underlying.readRange(0, HEADER_BYTES));
      const header = parseHeader(head);
      const indexLength = header.blockCount * INDEX_ENTRY_BYTES;
      if (header.indexOffset + indexLength > underlying.size) {
        throw new Error('compressed container: index runs past the end of the file');
      }
      const indexBytes = new Uint8Array(await underlying.readRange(header.indexOffset, indexLength));
      const entries = parseIndex(indexBytes, header);
      return new CompressedProvider(underlying, header, entries, options);
    }

    // Same contract as the other providers: a synchronous answer when the whole
    // path can be synchronous, otherwise null so the caller awaits readRange.
    readRangeSync(off, len) {
      if (!nodeZlib || typeof this.underlying.readRangeSync !== 'function') return null;
      const r = clampRange(this.size, off, len);
      if (!r.len) return new Uint8Array(0);
      const out = new Uint8Array(r.len);
      let written = 0;
      for (const block of this._blocksFor(r.start, r.end)) {
        const bytes = this._blockSync(block);
        if (!bytes) return null;
        written += this._copySlice(bytes, block, r, out, written);
      }
      return written === r.len ? out : out.subarray(0, written);
    }

    async readRange(off, len) {
      const r = clampRange(this.size, off, len);
      if (!r.len) return new Uint8Array(0);
      const out = new Uint8Array(r.len);
      let written = 0;
      for (const block of this._blocksFor(r.start, r.end)) {
        const bytes = await this._block(block);
        written += this._copySlice(bytes, block, r, out, written);
      }
      if (written !== r.len) {
        throw new Error(`CompressedProvider: delivered ${written} bytes for @${r.start}+${r.len}`);
      }
      return out;
    }

    // Which blocks a byte range touches, plus the sub-range of each.
    _blocksFor(start, end) {
      const first = Math.floor(start / this.blockSize);
      const last = Math.floor((end - 1) / this.blockSize);
      const out = [];
      for (let index = first; index <= last; index++) {
        const entry = this.entries[index];
        if (!entry) throw new Error(`CompressedProvider: no block ${index} for @${start}+${end - start}`);
        const blockStart = index * this.blockSize;
        const from = Math.max(start, blockStart) - blockStart;
        const to = Math.min(end, blockStart + entry.originalLength) - blockStart;
        out.push({ index, entry, from, to });
      }
      return out;
    }

    _copySlice(bytes, block, r, out, written) {
      const slice = bytes.subarray(block.from, block.to);
      out.set(slice, written);
      return slice.length;
    }

    _remember(index, bytes) {
      if (this._maxBlocks <= 0) return;
      this._blockCache.delete(index);
      this._blockCache.set(index, bytes);
      while (this._blockCache.size > this._maxBlocks) {
        this._blockCache.delete(this._blockCache.keys().next().value);
      }
    }

    _expand(entry, raw) {
      if (raw.length !== entry.compressedLength) {
        throw new Error(`CompressedProvider: block ${entry.index} read ${raw.length} bytes, ` +
          `index says ${entry.compressedLength}`);
      }
      if (entry.stored) {
        if (raw.length !== entry.originalLength) {
          throw new Error(`CompressedProvider: stored block ${entry.index} is the wrong length`);
        }
        return raw;
      }
      const bytes = inflateRawSync(raw);
      if (!bytes) return null;
      // A block that inflates to the wrong length is corrupt; refusing here
      // keeps the guest from reading shifted bytes.
      if (bytes.length !== entry.originalLength) {
        throw new Error(`CompressedProvider: block ${entry.index} inflated to ${bytes.length}, ` +
          `index says ${entry.originalLength}`);
      }
      return bytes;
    }

    _blockSync(block) {
      const cached = this._blockCache.get(block.index);
      if (cached) { this.stats.cacheHits++; return cached; }
      const raw = this.underlying.readRangeSync(block.entry.offset, block.entry.compressedLength);
      if (!raw) return null;
      const bytes = this._expand(block.entry, raw);
      if (!bytes) return null;
      this.stats.blocksInflated++;
      this.stats.inflateBytes += bytes.length;
      this._remember(block.index, bytes);
      return bytes;
    }

    async _block(block) {
      const cached = this._blockCache.get(block.index);
      if (cached) { this.stats.cacheHits++; return cached; }
      const raw = new Uint8Array(await this.underlying.readRange(
        block.entry.offset, block.entry.compressedLength));
      let bytes;
      if (block.entry.stored) {
        bytes = this._expand(block.entry, raw);
      } else {
        if (raw.length !== block.entry.compressedLength) {
          throw new Error(`CompressedProvider: block ${block.index} read ${raw.length} bytes, ` +
            `index says ${block.entry.compressedLength}`);
        }
        bytes = await inflateRawAsync(raw);
        if (bytes.length !== block.entry.originalLength) {
          throw new Error(`CompressedProvider: block ${block.index} inflated to ${bytes.length}, ` +
            `index says ${block.entry.originalLength}`);
        }
      }
      this.stats.blocksInflated++;
      this.stats.inflateBytes += bytes.length;
      this._remember(block.index, bytes);
      return bytes;
    }

    close() { if (this.underlying && this.underlying.close) this.underlying.close(); }
  }

  const api = {
    MAGIC,
    VERSION,
    HEADER_BYTES,
    INDEX_ENTRY_BYTES,
    FLAG_STORED,
    CompressedProvider,
    parseHeader,
    parseIndex,
    crc32,
    inflateRawSync,
    inflateRawAsync,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.compressedProvider = api;
})();
