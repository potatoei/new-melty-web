# Asset packaging and Cloudflare deployment

Two things in the original brief do not survive contact with the engine, and
they are the reason this document exists rather than a one-line command list:

1. **The assets cannot be compressed.** The engine reads a `.p` archive by HTTP
   *byte range* (`lib/byte-provider.js` `HttpRangeProvider`, joined across parts
   by `ConcatProvider`). A compressed part has no meaningful byte range: the
   loader would request bytes 1000–2000 of the *compressed* stream and hand the
   guest whatever that happens to land on. The repo already proves this in
   `lib/byte-provider.js` — the only "inflate" mention is for a small in-memory
   mount, never for a ranged one. So the parts are **raw bytes, always**. If you
   want transfer compression it has to be `Content-Encoding` applied by the host
   to a *whole* response, which is mutually exclusive with `Range`. Pick one:
   ranged streaming (this pipeline) or whole-file compressed downloads.

2. **`wrangler put` is not a Wrangler command.** KV uploads are
   `wrangler kv key put --path <file>` or `wrangler kv bulk put`. The driver
   `tools/cloudflare-upload.js` uses the former, one key per part, so a 900 MB
   archive's parts never have to be resident in one process.

What the splitter *does* buy you, which is what the 25 MB limit actually
demands, is byte-identical sequential parts under the object limit with the
EOF-marker convention the loader already implements.

---

## 1. Split

```bash
node tools/cloudflare-chunk.js assets/raw/MBAACC \
  --out=dist/assets/mbaa \
  --max-bytes=20971520 \
  --only=0002.p,0003.p \
  --manifest=dist/assets/mbaa/split.json
```

- `--max-bytes` defaults to 20 MiB and is refused above 24 MiB, which keeps every
  object strictly under Cloudflare's 25 MiB (26,214,400 byte) limit with
  headroom.
- Part names are `<name>.partNNN`, the convention `host.js` `_openRangeProvider`
  and `_assetPartUrl` already probe.
- A file that is an exact multiple of the part size gets an **empty marker part**
  after it, so the loader's "short part means EOF" rule terminates instead of
  probing forever. This mirrors `tools/deploy-berrry.js`.
- Output is a pure function of (bytes, `--max-bytes`): no timestamps, no
  compression. The manifest records a SHA-256 per part and per file, so a re-run
  can be diffed instead of trusted.

Verify at any time:

```bash
node tools/cloudflare-chunk.js assets/raw/MBAACC \
  --verify-only --manifest=dist/assets/mbaa/split.json --out=dist/assets/mbaa
```

`--verify-only` rebuilds every file from its parts and compares digests. It
fails if a part was tampered with *or* if the source changed after the split.

## 2. Upload to KV

```bash
npx wrangler kv namespace create MBAA_ASSETS
# paste the id into deploy/wrangler.toml

node tools/cloudflare-upload.js \
  --manifest=dist/assets/mbaa/split.json \
  --parts=dist/assets/mbaa \
  --namespace-id=<the id from above> \
  --key-prefix=mbaa/
```

The driver refuses to upload a set that does not rebuild (it hashes every part
against the manifest first), and it stores metadata beside each value
(`size`, `sha256`, `file`, `offset`, `index`) which the Worker uses to answer a
truncated upload with an error instead of a short `200`.

`--dry-run` prints the exact `wrangler kv key put` commands without running
them.

## 3. Deploy the Worker

```bash
cd deploy && npx wrangler deploy
```

`deploy/kv-worker.js` is the piece that makes KV usable by this engine at all:

- KV has **no native Range support** — `getWithMetadata` returns the whole value.
  The Worker slices it in the isolate and answers `206` with an exact
  `Content-Range`.
- A `HEAD` must carry `Accept-Ranges: bytes` and `Content-Length`, or
  `HttpRangeProvider.open()` refuses to mount the archive at all.
- A `Range` request is preflighted cross-origin because of the `Range` header,
  so the Worker answers `OPTIONS` and exposes `Accept-Ranges`,
  `Content-Length`, `Content-Range`, `ETag`.

`deploy/wrangler.toml` declares the `ASSETS` binding and the `mbaa/assets` key
layout.

## 4. Point the app at it

The engine needs the *published* URL in the manifest, and `preloadRanges` only
if you are pinning texture bytes at launch:

```json
{
  "schemaVersion": 1,
  "files": [{ "url": "https://mbaa-assets.<account>.workers.dev/mbaa/0002.p", "size": 921000000 }],
  "preloadAssets": ["0002.p"],
  "preloadRanges": { "0002.p": { "schemaVersion": 1, "size": 921000000, "ranges": [[0, 106496]] } }
}
```

The `size` in `preloadRanges` **must** equal the real file size, or the policy
refuses the list and falls back to a whole-file preload — and now says so in the
console (`preloadRangesRefused`) instead of doing it silently.

## 5. Test the delivery path

```bash
node tools/cloudflare-deploy-test.js
```

Covers the two places a mistake is silent and expensive: the Worker's Range
arithmetic (`bytes=a-b`, `bytes=a-`, suffix `bytes=-N`, clamping, `416`) and the
splitter's determinism plus byte-exact rebuild.
