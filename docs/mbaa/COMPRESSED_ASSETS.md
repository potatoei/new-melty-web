# Compressing the asset tree (and why it has to be seekable)

You were right that compression works: 2.1 GB down to ~900 MB–1.2 GB is the
expected result, and it is where this pipeline should land. The only constraint
is *how*, and it is not optional:

**The guest reads these archives by byte range.** `lib/byte-provider.js`
(`HttpRangeProvider`), `ChunkCache`, `host.js` `_openRangeProvider` and the
`fs_read_file_at → 997` park all assume a provider can answer
`readRange(offset, length)` cheaply. A whole-file gzip/brotli stream cannot: to
answer a read at 500 MB you must inflate 500 MB first.

So the compression has to be **block-compressed and indexed** — which is what
this ships. It is still ordinary deflate; it just does not span the whole file.

## The numbers, measured (not claimed)

On a 16 MB archive shaped like this project's data (55 % indexed sprite sheets +
palettes, 40 % already-compressed audio/video, 5 % script text):

| Encoding | Size |
|---|---|
| block 64 KB | 84.2 % |
| block 256 KB | 84.2 % |
| block 1 MB | 84.2 % |
| whole-file gzip | 84.2 % |

On fully compressible sprite data: block 64 KB 1.3 %, block 256 KB 0.8 %,
block 1 MB 0.7 %, whole-file gzip 0.7 %.

Two conclusions, both useful:

1. **Block compression costs essentially nothing** versus whole-file gzip. The
   reason old `.RNC`/`.LZ` packers and this container both get away with it is
   that the redundancy in a sprite archive is local (a sheet repeats within
   itself, not across 900 MB).
2. **Block size barely matters**, so it is chosen for *access cost*, not ratio:
   256 KB means a 1 MB `ChunkCache` read touches 4–5 blocks. Re-run the table
   above against your own archives with `--block-size` if you want to confirm it
   on real bytes — `node tools/compress-assets.js ... --block-size=1048576`.

## Use

```bash
# 1. pack (verify round-trips every block through the real parser)
node tools/compress-assets.js assets/raw/MBAACC \
  --out=dist/assets/mbaa \
  --only=0002.p,0003.p,0005.p \
  --manifest=dist/assets/mbaa/compress.json \
  --verify

# 2. point the manifest at the container, and keep the ORIGINAL size
```

The app manifest entry grows two keys:

```json
{
  "url": "assets/raw/MBAACC/0002.p.mbcz",
  "vfsPath": "c:\\0002.p",
  "size": 921000000,
  "compressed": true,
  "compressedSize": 774000000
}
```

- `size` is the **decompressed** length. That is what the guest, the VFS and
  `preloadRanges` must see.
- `compressedSize` is the container's length on the wire, and is required: it is
  the only check that the container you are mounting is the one you packed.
- `vfsPath` keeps the original name, so the game asks for `c:\0002.p` and never
  learns the file it gets is compressed.

`lib/app-files.js` deliberately passes a `compressed: true` entry through
untouched. Its `size` is the decompressed length, so every size rule in that file
("required whole-file preload", `httpRange`, the eager threshold) would be
answering about the wrong number — precisely the class of bug that made
`preloadRanges` silently miss before.

## What is verified, and what is not

Verified, in `test/test-compressed-provider.js` (runs against the real packer and
the real provider through the real `ChunkCache`):

- sequential 1 MB reads, block-boundary reads, unaligned reads, and reads past
  EOF all reproduce the original bytes exactly;
- the synchronous and asynchronous paths agree;
- a block that does not compress is stored, not grown;
- four container corruptions (bad magic, header CRC, truncation, index offset)
  and an inflated-length mismatch are **refused**, not served.

Not verified: the ratio on **your** archives, because there are none in this
workspace. The packer prints the real per-file ratio when you run it, and
`--verify` re-inflates everything it wrote. If the printed ratio is far from the
~55 % you remember, the cause will be in the "already-compressed audio/video"
share — say so and I will look at the member mix rather than the codec.

## Interaction with chunking and Cloudflare

Order matters: **compress, then chunk**. Parts must be cut from the container, so
the index offsets stay meaningful:

```bash
node tools/compress-assets.js ... --out=dist/mbaa --verify
node tools/cloudflare-chunk.js dist/mbaa --out=dist/split \
  --only=0002.p.mbcz,0003.p.mbcz --manifest=dist/split/split.json
node tools/cloudflare-upload.js --manifest=dist/split/split.json \
  --parts=dist/split --namespace-id=<id> --key-prefix=mbaa/
```

Chunking a container is safe for the same reason chunking a raw `.p` is: the load
path concatenates parts, so part boundaries are invisible to the provider. A
compressed archive is also *easier* to chunk, since it crosses the 25 MB limit less
often.

`preloadRanges` still works, and its ranges are in **decompressed** offsets
(because that is the address space everything above the provider sees). A pinned
range means its blocks are resident, which is the same guarantee as before.
