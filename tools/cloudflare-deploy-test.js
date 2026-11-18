#!/usr/bin/env node
'use strict';

// Tests for the Cloudflare delivery path: the Worker's HTTP Range semantics and
// the splitter's determinism.
//
//   node tools/cloudflare-deploy-test.js
//
// WHY THESE TWO. Everything else about the deployment is mechanical; these are
// the two places where a mistake is silent and expensive:
//
//   * A Range reply that is off by one byte, or a 206 whose Content-Range
//     disagrees with the manifest, makes lib/byte-provider.js either reject the
//     read (a Loading window in a fight) or -- worse -- accept bytes shifted by
//     one, which is a file that is resident but wrong.
//   * A splitter whose output depends on anything but (bytes, --max-bytes)
//     produces parts that a later run cannot reproduce, so a re-upload diff is
//     meaningless and a stale part becomes indistinguishable from a fresh one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const CHUNKER = path.join(ROOT, 'tools', 'cloudflare-chunk.js');
const WORKER = path.join(ROOT, 'deploy', 'kv-worker.js');

function run(args) {
  return execFileSync(process.execPath, args, { encoding: 'utf8' });
}

// ---- the Worker's pure range parser ---------------------------------------
// The Worker is an ES module, so it is imported rather than required, and the
// test does not need a Workers runtime: parseRange is exported for exactly this.
async function workerTests() {
  const mod = await import(pathToFileURL(WORKER).href);
  const { parseRange } = mod;
  assert.strictEqual(typeof parseRange, 'function', 'parseRange is exported');

  const SIZE = 1000;
  // `bytes=0-499` -> the first half.
  assert.deepStrictEqual(parseRange('bytes=0-499', SIZE), { start: 0, end: 499 });
  // Open-ended: to the last byte.
  assert.deepStrictEqual(parseRange('bytes=500-', SIZE), { start: 500, end: 999 });
  // A suffix range is the LAST N bytes, not the first N.
  assert.deepStrictEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 });
  // An end past EOF is clamped, which is what a 206 contract allows.
  assert.deepStrictEqual(parseRange('bytes=900-99999', SIZE), { start: 900, end: 999 });
  // Exactly one byte, both forms.
  assert.deepStrictEqual(parseRange('bytes=999-999', SIZE), { start: 999, end: 999 });
  assert.deepStrictEqual(parseRange('bytes=-1', SIZE), { start: 999, end: 999 });
  // Past the end is unsatisfiable (416), not an empty 206.
  assert.deepStrictEqual(parseRange('bytes=1000-', SIZE), { unsatisfiable: true });
  assert.deepStrictEqual(parseRange('bytes=-0', SIZE), { unsatisfiable: true });
  // Nonsense and multi-range fall back to the whole thing, which a 200 mount
  // accepts; they must never throw.
  assert.strictEqual(parseRange('bytes=abc', SIZE), null);
  assert.strictEqual(parseRange('items=0-1', SIZE), null);
  assert.strictEqual(parseRange('', SIZE), null);

  // The CORS answer must expose the headers the loader reads, or the page sees
  // a CORS error instead of Accept-Ranges.
  const { corsHeaders } = mod;
  const headers = corsHeaders({});
  assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
  for (const name of ['Accept-Ranges', 'Content-Length', 'Content-Range', 'ETag']) {
    assert.ok(headers['Access-Control-Expose-Headers'].includes(name),
      `the page can read ${name}`);
  }
  assert.ok(/Range/.test(headers['Access-Control-Allow-Headers']),
    'a Range request preflights with that header, so it must be allowed');

  // A real request against a fake KV namespace, end to end: HEAD, GET, Range,
  // and a 416. This is the contract HttpRangeProvider.open() checks.
  const { default: worker } = mod;
  const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 0xff));
  const env = {
    ASSETS: {
      async getWithMetadata(key) {
        if (key !== 'mbaa/x.p.part000') return { value: null, metadata: null };
        return { value: BODY.buffer.slice(BODY.byteOffset, BODY.byteOffset + BODY.length),
          metadata: { size: BODY.length, sha256: 'deadbeef' } };
      },
    },
  };
  const head = await worker.fetch(new Request('https://a.example/mbaa/x.p.part000', { method: 'HEAD' }), env);
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(head.headers.get('content-length'), '1000');

  const ranged = await worker.fetch(new Request('https://a.example/mbaa/x.p.part000',
    { headers: { Range: 'bytes=10-19' } }), env);
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(ranged.headers.get('content-range'), 'bytes 10-19/1000');
  assert.strictEqual(ranged.headers.get('content-length'), '10');
  const bytes = new Uint8Array(await ranged.arrayBuffer());
  assert.strictEqual(bytes.length, 10);
  assert.deepStrictEqual([...bytes], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    'the 206 body is the bytes the Content-Range claims');

  const past = await worker.fetch(new Request('https://a.example/mbaa/x.p.part000',
    { headers: { Range: 'bytes=5000-' } }), env);
  assert.strictEqual(past.status, 416);
  assert.strictEqual(past.headers.get('content-range'), 'bytes */1000');

  const missing = await worker.fetch(new Request('https://a.example/mbaa/nope.p'), env);
  assert.strictEqual(missing.status, 404);

  const preflight = await worker.fetch(new Request('https://a.example/mbaa/x.p.part000',
    { method: 'OPTIONS' }), env);
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), '*');
}

// ---- the splitter ---------------------------------------------------------
function chunkerTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-chunk-'));
  const src = path.join(dir, 'src');
  const outA = path.join(dir, 'a');
  const outB = path.join(dir, 'b');
  fs.mkdirSync(src);
  // Three shapes that exercise every branch: a multi-part file, a file smaller
  // than one part, and a file that is an EXACT multiple (the empty marker).
  const sizes = { '0002.p': 45, '0003.p': 7, 'exact.bin': 20 };
  const payloads = {};
  for (const [name, units] of Object.entries(sizes)) {
    // Deterministic pseudo-random bytes: no Math.random, so a failure repeats.
    const bytes = Buffer.alloc(units * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + name.length * 7) & 0xff;
    payloads[name] = bytes;
    fs.writeFileSync(path.join(src, name), bytes);
  }
  const MAX = String(20 * 1024);

  run([CHUNKER, src, `--out=${outA}`, `--max-bytes=${MAX}`, `--manifest=${path.join(dir, 'a.json')}`]);
  run([CHUNKER, src, `--out=${outB}`, `--max-bytes=${MAX}`, `--manifest=${path.join(dir, 'b.json')}`]);

  // Determinism: same input, same part names, same bytes, same digests.
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'));
  assert.deepStrictEqual(a.files, b.files, 'two runs produce identical manifests');
  assert.strictEqual(a.partSize, 20 * 1024);
  assert.strictEqual(a.conventions.compression, 'none');

  // Concatenation: the parts ARE the file. This is the only property that
  // matters, and it is checked here rather than trusted from the splitter.
  for (const record of a.files) {
    const rebuilt = Buffer.concat(record.parts.filter(p => !p.marker)
      .map(p => fs.readFileSync(path.join(outA, p.name))));
    assert.deepStrictEqual(rebuilt, payloads[record.name],
      `${record.name} rebuilds byte-for-byte`);
    assert.strictEqual(record.size, payloads[record.name].length);
  }

  // 0002.p (45 KiB at 20 KiB parts) -> 3 parts, the last short.
  const big = a.files.find(f => f.name === '0002.p');
  assert.strictEqual(big.parts.length, 3);
  assert.strictEqual(big.parts[2].length, 5 * 1024);
  // exact.bin (20 KiB) -> one full part plus an EMPTY marker, so the loader's
  // "short part means EOF" rule terminates instead of probing part001 forever.
  const exact = a.files.find(f => f.name === 'exact.bin');
  assert.strictEqual(exact.parts.length, 2);
  assert.strictEqual(exact.parts[1].length, 0);
  assert.strictEqual(exact.parts[1].marker, true);
  assert.strictEqual(fs.statSync(path.join(outA, exact.parts[1].name)).size, 0);

  // Every part is strictly under Cloudflare's object limit, whichever size the
  // caller asked for (the tool refuses one that is not).
  for (const record of a.files) {
    for (const part of record.parts) {
      assert.ok(part.length < 25 * 1024 * 1024, `${part.name} is under the 25MB limit`);
    }
  }

  // THE TERMINATION RULE. host.js ends a part list on the first part shorter
  // than ASSET_PART_SIZE (10 MiB), and its eager path THROWS if the next index
  // 404s. With 20 MiB parts, a file whose tail lands between 10 and 20 MiB ends
  // on a full-size part, so the eager reader asks for one part too many and
  // fails -- while the ranged reader tolerates it and works. Same split, two
  // behaviours, which is the kind of difference that only shows up in one code
  // path at a time. The splitter therefore emits a zero-byte marker whenever the
  // last real part is not already below the threshold.
  {
    const EOF = 10 * 1024 * 1024;
    const tailDir = path.join(dir, 'tailsrc');
    const tailOut = path.join(dir, 'tailout');
    fs.mkdirSync(tailDir);
    // 3 x 20 MiB + a 15 MiB tail: the tail is >= EOF, so it needs a marker.
    fs.writeFileSync(path.join(tailDir, 'tail.p'), Buffer.alloc(20 * 1024 * 1024 * 3 + 15 * 1024 * 1024, 0x41));
    run([CHUNKER, tailDir, `--out=${tailOut}`, '--max-bytes=' + String(20 * 1024 * 1024)]);
    const parts = fs.readdirSync(tailOut).filter(f => /\.part\d{3}$/.test(f)).sort();
    const sizes = parts.map(f => fs.statSync(path.join(tailOut, f)).size);
    assert.strictEqual(sizes[sizes.length - 1], 0,
      'a tail at or above the 10 MiB EOF threshold ends with an empty marker');
    // Simulate BOTH readers over the emitted list.
    let total = 0;
    for (let i = 0; ; i++) {
      const name = parts.find(f => f.endsWith('.part' + String(i).padStart(3, '0')));
      assert.ok(name, `part ${i} exists (the eager reader would throw here)`);
      const size = fs.statSync(path.join(tailOut, name)).size;
      total += size;
      if (size < EOF) break;
    }
    assert.strictEqual(total, 20 * 1024 * 1024 * 3 + 15 * 1024 * 1024,
      'the marker-terminated list rebuilds the exact file');
  }

  // A refusal is a refusal: a --max-bytes at or over the limit must exit
  // non-zero rather than write parts that cannot be uploaded.
  let refused = false;
  try {
    execFileSync(process.execPath, [CHUNKER, src, `--out=${path.join(dir, 'c')}`,
      '--max-bytes=26214400'], { stdio: 'pipe' });
  } catch (error) {
    refused = error.status !== 0;
  }
  assert.ok(refused, 'a part size at the Cloudflare limit is refused');

  // --verify-only accepts the good split and rejects a tampered part.
  run([CHUNKER, src, '--verify-only', `--manifest=${path.join(dir, 'a.json')}`, `--out=${outA}`]);
  const victim = path.join(outA, big.parts[0].name);
  const original = fs.readFileSync(victim);
  const tampered = Buffer.from(original);
  tampered[0] ^= 0xff;
  fs.writeFileSync(victim, tampered);
  let caught = false;
  try {
    execFileSync(process.execPath, [CHUNKER, src, '--verify-only',
      `--manifest=${path.join(dir, 'a.json')}`, `--out=${outA}`], { stdio: 'pipe' });
  } catch (error) {
    caught = error.status !== 0;
  }
  assert.ok(caught, 'a tampered part fails --verify-only');
}

(async () => {
  await workerTests();
  chunkerTests();
  console.log('PASS cloudflare delivery: Worker Range/206/CORS semantics and deterministic sub-25MB splitting');
})();
