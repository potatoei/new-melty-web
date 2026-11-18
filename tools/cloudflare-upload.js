#!/usr/bin/env node
'use strict';

// Upload the split asset tree to Workers KV, one key per part, with the metadata
// the Worker needs -- and refuse to upload a set that does not rebuild.
//
//   node tools/cloudflare-upload.js --manifest=split.json --parts=<dir>
//        --namespace-id=<id> [--key-prefix=mbaa/] [--account-id=<id>]
//        [--dry-run] [--force] [--concurrency=4]
//
// WHAT IT DOES NOT DO
//
//   * It does not re-chunk. The manifest from tools/cloudflare-chunk.js is the
//     single description of the split; re-deriving it here would be a second
//     source of truth for part boundaries, which is exactly the class of bug
//     that produces a file that is resident but wrong.
//   * It does not trust the manifest. Every part is hashed and compared before
//     it is uploaded, and a mismatch stops the run. Uploading parts that do not
//     concatenate to the original is worse than uploading nothing, because the
//     engine will happily mount them.
//   * It does not put more than one key per invocation into a bulk payload it
//     cannot verify. `wrangler kv key put --path` streams one file, which keeps
//     a 900 MB archive's parts out of this process's memory.
//
// Wrangler is invoked as a subprocess (`npx wrangler ...`) rather than imported,
// so the version pinned in the caller's project is the one that runs; this
// script only decides WHAT to upload and checks it first.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function usage() {
  console.error('usage: cloudflare-upload.js --manifest=split.json --parts=<dir> ' +
    '--namespace-id=<id> [--key-prefix=mbaa/] [--account-id=<id>] [--dry-run] [--force]');
  process.exit(2);
}

const args = process.argv.slice(2);
const arg = name => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
const manifestPath = arg('manifest');
const partsDir = arg('parts');
const namespaceId = arg('namespace-id');
const keyPrefix = (arg('key-prefix') || '').replace(/^\/+/, '');
const accountId = arg('account-id');
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

if (!manifestPath || !partsDir || !namespaceId) usage();
if (!fs.existsSync(manifestPath)) {
  console.error(`cloudflare-upload: no manifest at ${manifestPath}`);
  process.exit(2);
}
if (!fs.existsSync(partsDir)) {
  console.error(`cloudflare-upload: no parts directory at ${partsDir}`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const MAX_KV_VALUE = 25 * 1024 * 1024;   // Cloudflare's per-value limit

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- preflight: prove the split before touching the network ----------------
const problems = [];
const work = [];
for (const file of manifest.files) {
  const rebuilt = crypto.createHash('sha256');
  for (const part of file.parts) {
    const filePath = path.join(partsDir, part.name);
    if (!fs.existsSync(filePath)) {
      problems.push(`${file.name}: missing part ${part.name}`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.byteLength !== part.length) {
      problems.push(`${part.name}: is ${bytes.byteLength} bytes, manifest says ${part.length}`);
      continue;
    }
    const digest = sha256File(filePath);
    if (digest !== part.sha256) {
      problems.push(`${part.name}: sha256 ${digest} != manifest ${part.sha256}`);
      continue;
    }
    if (bytes.byteLength > MAX_KV_VALUE) {
      problems.push(`${part.name}: ${bytes.byteLength} bytes is over KV's ${MAX_KV_VALUE}-byte ` +
        'per-value limit; re-split with a smaller --max-bytes');
      continue;
    }
    if (!part.marker && part.length === 0) {
      problems.push(`${part.name}: zero length but not a marker`);
      continue;
    }
    if (!part.marker) rebuilt.update(bytes);
    work.push({ key: keyPrefix + part.name, path: filePath, meta: {
      // The Worker serves these back; `size` lets it answer a truncated upload
      // with an error instead of a short 200.
      size: part.length,
      sha256: part.sha256,
      file: file.name,
      offset: part.offset,
      index: part.index,
      ...(part.marker ? { marker: true } : {}),
    } });
  }
  const got = rebuilt.digest('hex');
  if (got !== file.sha256) {
    problems.push(`${file.name}: parts rebuild to ${got}, manifest says ${file.sha256}`);
  }
}

if (problems.length) {
  console.error(`cloudflare-upload: refusing to upload -- ${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(`preflight OK: ${manifest.files.length} file(s), ${work.length} key(s), ` +
  `${manifest.totals ? manifest.totals.bytes : ''} bytes`);

// ---- upload ---------------------------------------------------------------
function wrangler(argsList) {
  const result = spawnSync('npx', ['wrangler', ...argsList], {
    stdio: 'inherit',
    // The caller's CLOUDFLARE_API_TOKEN is passed through untouched; nothing is
    // read from disk here and nothing is logged.
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

let uploaded = 0, failed = 0;
for (const item of work) {
  const command = ['kv', 'key', 'put', item.key,
    '--namespace-id', namespaceId,
    '--path', item.path,
    '--metadata', JSON.stringify(item.meta),
    ...(accountId ? ['--account-id', accountId] : []),
    ...(FORCE ? [] : [])];
  if (DRY_RUN) {
    console.log(`[dry-run] wrangler ${command.join(' ')}`);
    uploaded++;
    continue;
  }
  if (wrangler(command)) {
    uploaded++;
    console.log(`uploaded ${item.key} (${item.meta.size} bytes)`);
  } else {
    failed++;
    console.error(`FAILED ${item.key}`);
  }
}

console.log(`${DRY_RUN ? 'would upload' : 'uploaded'} ${uploaded} key(s), ${failed} failure(s)`);
if (failed) process.exit(1);
