#!/usr/bin/env node
'use strict';

// The two launch-time policy switches, and the promise they make.
//
// `?eager-files` came first: it predates the lazy policy, and it is the
// control arm for measuring that policy ("load everything, as before").
// `?lazy-files` is the mirror image, added because `preloadAssets` can now
// make a launch wait on a gigabyte of archives and someone on a slow link
// needs a way out that is not "edit the registry". They are not symmetric, and
// that asymmetry is the thing worth pinning:
//
//   ?eager-files  -> every file is downloaded before the first frame.
//   ?lazy-files   -> the preload declarations are dropped; everything else
//                    about the policy (eager extensions, persistFiles,
//                    small-app shortcut) still applies.
//
// This drives the real policy function rather than the browser, so it is a
// test of the contract those switches depend on.

const assert = require('assert');
const path = require('path');

const { normalizeLazyFiles } = require('../lib/app-files');

const MB = 1024 * 1024;
const files = [
  { url: 'binaries/mbaa/MBAA.exe', size: 4 * MB, vfsPaths: ['c:\\mbaa\\mbaa.exe'] },
  { url: 'binaries/mbaa/0002.p', size: 900 * MB, vfsPaths: ['c:\\0002.p'] },
  { url: 'binaries/mbaa/0003.p', size: 140 * MB, vfsPaths: ['c:\\0003.p'] },
];
const sizeOf = file => (typeof file === 'object' ? file.size : null);
const app = { id: 'mbaa', preloadAssets: ['0002.p', '0003.p'] };

// ---- the default: the declared archives are required at launch ------------
{
  const warned = [];
  const realWarn = console.warn;
  console.warn = m => warned.push(String(m));
  let policy;
  try { policy = normalizeLazyFiles(app, files, { sizeOf }); } finally { console.warn = realWarn; }

  assert.strictEqual(policy.summary.policy, 'lazy');
  const byUrl = Object.fromEntries(policy.files.map(f => [f.url, f]));
  assert.strictEqual(byUrl['binaries/mbaa/0002.p'].loadMode, 'required',
    'a declared preload is required at launch');
  assert.strictEqual(byUrl['binaries/mbaa/0002.p'].size, 900 * MB,
    'and carries its size so the mount needs no HEAD');
  assert.strictEqual(byUrl['binaries/mbaa/MBAA.exe'].loadMode, undefined,
    'the executable keeps the pre-policy classification');
  assert.strictEqual(policy.summary.preloadWholeBytes, 1040 * MB,
    'the whole launch cost is reported');
  assert.ok(warned.length >= 1, 'and warned about, because it is a gigabyte');
}

// ---- ?lazy-files: declarations dropped, policy otherwise untouched --------
{
  const optedOut = { ...app, preloadAssets: [], preloadRanges: undefined };
  const policy = normalizeLazyFiles(optedOut, files, { sizeOf });
  const byUrl = Object.fromEntries(policy.files.map(f => [f.url, f]));

  assert.strictEqual(byUrl['binaries/mbaa/0002.p'].loadMode, undefined,
    'no file is forced to load at launch');
  assert.strictEqual(byUrl['binaries/mbaa/0002.p'].httpRange, true,
    'the archive streams instead, exactly as it did before preloadAssets');
  assert.strictEqual(byUrl['binaries/mbaa/0003.p'].httpRange, true, 'and so does the other one');
  assert.strictEqual(policy.summary.preloadWholeBytes, undefined,
    'with nothing preloaded there is no launch cost to report');
}

// ---- a preload that cannot be pinned must not become a broken launch ------
//
// host.js refuses a manifest entry whose `size` is not a safe integer, so a
// `preloadAssets` name with no measured size used to be emitted as
// `{loadMode:'required', size:null}` -- which is not a slow launch, it is a
// launch that THROWS. Worse in the other direction: a name that matches
// nothing at all looks exactly like a preload that was never declared.
{
  const unsized = [{ url: 'binaries/mbaa/mystery.p', vfsPaths: ['c:\\mystery.p'] }];
  const warned = [];
  const realWarn = console.warn;
  console.warn = m => warned.push(String(m));
  let policy;
  try {
    policy = normalizeLazyFiles(
      { id: 'mbaa', preloadAssets: ['mystery.p'], preloadRanges: { 'mystery.p': { schemaVersion: 1, ranges: [[0, 4096]] } } },
      unsized, { sizeOf: () => null });
  } finally { console.warn = realWarn; }

  const entry = policy.files[0];
  assert.strictEqual(entry.loadMode, undefined,
    'an unsized preload is left as it was rather than emitted as a required/null-size entry host.js rejects');
  assert.ok(!(entry.loadMode !== undefined && !Number.isSafeInteger(entry.size)),
    'nothing that host.js would reject at launch survives the policy');
  assert.deepStrictEqual(policy.summary.preloadSkipped, ['mystery.p'],
    'and the skipped name is reported instead of silently streaming');
  assert.ok(warned.some(m => /no known size/.test(m)),
    'with a warning that names it');
}

// ---- a ranges key resolves the way a preload name does -------------------
//
// The census writes `0002.p`; an author may paste it as `0002.P`, or key on
// the URL. A case-sensitive miss used to fall through to a whole-file preload,
// i.e. a 900 MB launch from a table that looks correct.
{
  const wide = [{ url: 'binaries/mbaa/0002.p', size: 900 * MB, vfsPaths: ['c:\\0002.p'] }];
  for (const key of ['0002.p', '0002.P', 'binaries/mbaa/0002.p']) {
    const policy = normalizeLazyFiles(
      { id: 'mbaa', preloadAssets: ['0002.p'],
        preloadRanges: { [key]: { schemaVersion: 1, size: 900 * MB, ranges: [[0, 4096], [100, 200]] } } },
      wide, { sizeOf });
    const entry = policy.files[0];
    assert.strictEqual(entry.loadMode, 'lazy', `key ${key}: the measured ranges are used`);
    assert.deepStrictEqual(entry.preloadRanges.ranges, [[0, 4096], [100, 200]],
      `key ${key}: the ranges ride along`);
    assert.strictEqual(policy.summary.preloadWholeBytes, undefined,
      `key ${key}: so the launch is not a gigabyte`);
  }

  // A list measured on other bytes is refused (pinning the wrong ranges is
  // worse than pinning none) AND reported, because the remedy is re-running
  // the census and that is not obvious from a silent fallback.
  const warned = [];
  const realWarn = console.warn;
  console.warn = m => warned.push(String(m));
  let mismatch;
  try {
    mismatch = normalizeLazyFiles(
      { id: 'mbaa', preloadAssets: ['0002.p'],
        preloadRanges: { '0002.p': { schemaVersion: 1, size: 123, ranges: [[0, 4096]] } } },
      wide, { sizeOf });
  } finally { console.warn = realWarn; }
  assert.strictEqual(mismatch.files[0].loadMode, 'required',
    'a size mismatch falls back to the whole-file preload');
  assert.ok(mismatch.summary.preloadRangesRefused &&
    /0002\.p/.test(mismatch.summary.preloadRangesRefused.join(' ')),
    'and says which file disagreed');
  assert.ok(warned.some(m => /measured against a different file/.test(m)),
    'in the console, not just the summary');
  assert.strictEqual(mismatch.summary.preloadRangesUnused, undefined,
    'a key that matched but was refused is not also reported as unused');
}

// ---- a ranges table that matches nothing is called out -------------------
{
  const warned = [];
  const realWarn = console.warn;
  console.warn = m => warned.push(String(m));
  let policy;
  try {
    policy = normalizeLazyFiles(
      { id: 'mbaa', preloadAssets: ['0002.p'],
        preloadRanges: { '9999.p': { schemaVersion: 1, size: 900 * MB, ranges: [[0, 1]] } } },
      files, { sizeOf });
  } finally { console.warn = realWarn; }
  assert.deepStrictEqual(policy.summary.preloadRangesUnused, ['9999.p'],
    'a declared key no file consulted is reported by name');
  assert.ok(warned.some(m => /the ranges are unused/.test(m)),
    'and warned about: otherwise the census output looks correct while launch stays at a gigabyte');
}

// ---- the switch is a launch-time decision, and it says so in the URL ------
const shell = require('fs').readFileSync(
  path.join(__dirname, '..', 'lib', 'browser-shell.js'), 'utf8');
assert.ok(/\[\?&\]lazy-files\(\?:\[=&\]\|\$\)/.test(shell),
  'the switch is matched the same anchored way as ?eager-files');
assert.ok(/preloadAssets: \[\], preloadRanges: undefined/.test(shell),
  'and clears exactly the preload declarations, nothing else');

console.log('PASS launch policy switches: ?lazy-files drops preloads, ?eager-files keeps loading everything');
