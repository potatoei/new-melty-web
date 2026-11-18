'use strict';

// The default download policy for an app's companion files: which load at
// launch and which stay on the server and stream as the guest reads them.
//
// Both hosts call normalizeLazyFiles() on the same files[] (lib/browser-shell.js
// before wine.loadFiles, test/run.js before mounting), so a headless
// `--lazy-ranges` run audits exactly the decision the page makes.
//
// A lazy file is a read-only provider-backed VFS entry (lib/filesystem.js).
// ReadFile, read-only MapViewOfFile, Win32 _lread/_hread, mmio refills, the
// AVI reader, PlaySound/sndPlaySound, BASS_SampleLoad and LoadImage /
// ImageList_LoadImage from a file park the guest on a cache miss, and the MCI
// waveaudio/sequencer devices attach a streamed file when it arrives; other
// consumers need the bytes in the same turn (the Win16 _lread bridge, DLL and
// resource loading, fonts, help, writable mappings, writes). So the policy keeps eager, BY FILE CLASS (never by
// size), what those consumers read, and streams everything else -- small
// files too.
//
// Rules, in order:
//   1. app.lazyFiles === false            -> every file eager (per-app opt-out)
//   2. a Win16 (NE) main image            -> every file eager (its _lread
//      bridge cannot park)
//   3. a file that already says how it loads (loadMode, httpRange true/false,
//      eager:true, preloadRanges, decodeImage) -> left exactly as written
//   4. all sizes known and their total < APP_EAGER_BYTES -> every file eager
//      (Solitaire-sized apps load as before)
//   5. a file whose size is unknown (no `size`, no sizeOf answer) -> eager
//   6. per file eager: an extension a synchronous consumer reads
//      (EAGER_EXTENSIONS), or a path app.persistFiles names (the guest
//      writes it), or a file app.requiredFiles names (rule 6b)
//   6b. app.preloadAssets names the files that must be IN before the game
//      takes its first frame -- sprite archives, stage archives. This is the
//      per-file answer to "stream all the textures before the player is in
//      the game" without making every byte of a 900MB archive a launch cost:
//      a named file gets `loadMode: 'required'` (whole, with progress) or,
//      when the app declares `preloadRanges` for it, a measured range list
//      that host.js fetches during launch while the rest still streams.
//      A required whole file must be mountable: host.js mounts a sized entry
//      over one release part (ASSET_PART_SIZE) synchronously and discovers
//      the .partNNN split with a HEAD above that, so both shapes work.
//   7. otherwise streamed: {httpRange:true, size}. host.js mounts a sized
//      entry up to one release part with no HEAD, and a host without Range
//      support hands its first read the whole file (acceptWhole).
(function () {
  const APP_EAGER_BYTES = 16 * 1024 * 1024;
  // Above this, a whole-file preload is worth a warning: it trades a launch
  // the user can cancel for a download they may not have asked for.
  const PRELOAD_WHOLE_WARN_BYTES = 64 * 1024 * 1024;

  // The name a warning should call a file: the URL leaf, which is what the
  // user sees in the launch window.
  function leafOf(file) {
    const url = fileUrl(file);
    return url ? url.replace(/^.*\//, '') : String(file && file.url || file);
  }

  // `compressed: true` names a container in lib/compressed-provider.js's MBCZ
  // format. Its `size` is the DECOMPRESSED length (that is what the guest and
  // the VFS must see) and `compressedSize` is the length on the wire, so every
  // size-based rule in this file would otherwise be answering about the wrong
  // number -- and the size mismatch is exactly what the preload policy refuses.
  function declaresCompressed(file) {
    return !!(file && typeof file === 'object' && file.compressed === true);
  }

  // Read by something that cannot park on a cache miss: the PE/DLL loader
  // (images, codecs, plug-ins, type libraries), resource and font loading,
  // INI/registry-ish config, fonts and WinHelp.
  // AVI is not here: the 09a7f reader behind AVIFile and MCI avivideo parks a
  // missed chunk read and restarts the call, like ReadFile.
  const EAGER_EXTENSIONS = new Set([
    'exe', 'dll', 'drv', 'ocx', 'ax', 'acm', 'cpl', 'vxd', 'asi', 'm3d', 'flt', 'tlb', 'olb',
    'ini', 'inf', 'cfg', 'reg',
    'ttf', 'ttc', 'fon', 'fnt',
    'hlp', 'cnt', 'chm',
    // AoE II's EBUEula.dll hands EULA.RTF to a reader that cannot park.
    'rtf',
  ]);
  // Audio and images have no class of their own: every reader of a sound or
  // picture file parks or attaches late -- PlaySound/sndPlaySound,
  // BASS_SampleLoad, mmio, ReadFile, the MCI devices (readFileAsync), and
  // LoadImage/ImageList_LoadImage(LR_LOADFROMFILE) bitmaps -- so they stream
  // like any data file. Colin McRae's demo used to load 591 .wav before its
  // first frame because its exe names PlaySound. (LoadCursorFromFile and
  // icon/cursor LoadImage do not read the file at all yet.)

  function fileUrl(file) {
    return typeof file === 'string' ? file : (file && file.url) || '';
  }

  function extensionOf(url) {
    const leaf = String(url).replace(/[?#].*$/, '').replace(/^.*[\\/]/, '');
    const dot = leaf.lastIndexOf('.');
    return dot < 0 ? '' : leaf.slice(dot + 1).toLowerCase();
  }

  function vfsPathsOf(file) {
    if (typeof file === 'string') return ['c:\\' + file.replace(/^.*[\\/]/, '').toLowerCase()];
    if (Array.isArray(file.vfsPaths)) return file.vfsPaths.map(normalizePath);
    if (file.vfsPath) return [normalizePath(file.vfsPath)];
    return ['c:\\' + fileUrl(file).replace(/^.*[\\/]/, '').toLowerCase()];
  }

  function normalizePath(path) {
    let p = String(path || '').toLowerCase().replace(/\//g, '\\');
    if (!/^[a-z]:/.test(p)) p = 'c:\\' + p.replace(/^\\+/, '');
    return p;
  }

  // Same glob shape as lib/vfs-persistence.js persistFiles.
  function patternRegex(pattern) {
    const escaped = normalizePath(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$');
  }

  function declaresLoading(file) {
    return typeof file === 'object' && file !== null && (
      file.loadMode !== undefined || file.httpRange !== undefined || file.eager === true ||
      file.preloadRanges !== undefined || file.decodeImage);
  }

  function sizeFor(file, sizeOf) {
    if (typeof file === 'object' && file && Number.isSafeInteger(file.size) && file.size >= 0) return file.size;
    if (typeof sizeOf === 'function') {
      const size = sizeOf(fileUrl(file), file);
      if (Number.isSafeInteger(size) && size >= 0) return size;
    }
    return null;
  }

  // Returns { files, summary }. `files` is a new array; entries left eager are
  // the original objects, lazy ones are shallow copies. Never mutates `app`.
  function normalizeLazyFiles(app, files, options = {}) {
    const list = Array.isArray(files) ? files : [];
    const summary = {
      policy: 'lazy', eagerFiles: 0, lazyFiles: 0, eagerBytes: 0, lazyBytes: 0, unknownSizes: 0,
    };
    const finish = (out, policy) => {
      summary.policy = policy;
      for (let i = 0; i < out.length; i++) {
        const size = sizeFor(out[i], options.sizeOf);
        const lazy = typeof out[i] === 'object' && out[i] &&
          (out[i].loadMode === 'lazy' || out[i].loadMode === 'background' ||
           (out[i].httpRange === true && out[i].loadMode !== 'required'));
        if (lazy) { summary.lazyFiles++; summary.lazyBytes += size || 0; }
        else { summary.eagerFiles++; summary.eagerBytes += size || 0; }
        if (size === null) summary.unknownSizes++;
      }
      return { files: out, summary };
    };
    if (app && app.lazyFiles === false) return finish(list.slice(), 'eager: app.lazyFiles false');
    if (options.isWin16) return finish(list.slice(), 'eager: Win16 image');

    const sizes = list.map(file => sizeFor(file, options.sizeOf));
    if (sizes.every(size => size !== null)) {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (total < APP_EAGER_BYTES) return finish(list.slice(), 'eager: small app');
    }
    const persist = (app && Array.isArray(app.persistFiles) ? app.persistFiles : []).map(patternRegex);
    // `preloadAssets` -> the set of vfs paths (or URL leaves) that must be in
    // before the first frame. Matched the same loose way as persistFiles: a
    // bare file name, a `c:\dir\file.p` path, or a URL leaf all work, because
    // a registry entry's files are keyed by URL while the app author thinks in
    // the guest's names.
    const preload = preloadMatchers(app);
    const rangeFor = rangeListFor(app);
    const rangesUsed = rangeFor.used;
    const rangesRefused = rangeFor.refused;
    const rangesRefusedKeys = rangeFor.refusedKeys;
    // A preloaded file with no measured ranges costs its WHOLE size at launch.
    // That is the right answer for a 20 MB archive and the wrong one for
    // MBAACC's 900 MB sprite pack, and the difference is invisible until the
    // launch window sits at 3% for ten minutes. Sum it here, warn once with
    // the numbers, and keep going: refusing would turn a slow launch into no
    // launch, and the caller may well be on a fast pipe.
    let preloadWholeBytes = 0;
    const preloadWhole = [];
    const preloadSkipped = [];
    const out = list.map((file, i) => {
      // A block-compressed container is mounted by host.js through
      // lib/compressed-provider.js, which presents the ORIGINAL size to
      // everything above it. The policy must not re-derive that entry: forcing
      // it 'required' would fetch the container whole (defeating the point of
      // streaming it), and httpRange on a container whose manifest size is the
      // decompressed length would ask the host for bytes that do not exist.
      if (!fileUrl(file) || declaresLoading(file) || declaresCompressed(file)) return file;
      const size = sizes[i];
      const wanted = preload.length &&
        preloadCandidates(file).some(path => preload.some(re => re.test(path)));
      if (wanted) {
        // Measured ranges: the app knows which bytes are textures, so only
        // those are launch cost and the rest keeps streaming. An UNSIZED file
        // cannot be pinned at all -- there is no size to hang the list on and
        // host.js rejects such an entry -- so this is checked before the
        // ranges are consulted, not after.
        const ranges = typeof size === 'number' ? rangeFor(file, size) : null;
        if (ranges) {
          const base = typeof file === 'string' ? { url: file } : { ...file };
          return { ...base, size, loadMode: 'lazy', preloadRanges: ranges };
        }
        // A preload is only meaningful as a SIZED declaration: host.js rejects
        // an entry whose `size` is not a safe integer, and an unsized name
        // carries nothing to pin. Leaving the entry as it was streams it
        // exactly as before -- the preload was always best-effort, and one
        // unsized name must never take the launch down. `preloadSkipped` says
        // so in the summary instead of passing silently.
        if (typeof size !== 'number') {
          preloadSkipped.push(leafOf(file));
          return file;
        }
        // Whole file, with the launch window's progress and Cancel. `required`
        // means a failure fails the launch instead of streaming on demand,
        // which is the point: the guest caches a failed read as NULL forever.
        preloadWholeBytes += size;
        preloadWhole.push(`${leafOf(file)} ${(size / (1024 * 1024)).toFixed(0)}MB`);
        const base = typeof file === 'string' ? { url: file } : { ...file };
        return { ...base, size, loadMode: 'required' };
      }
      // Unknown size: eager. An unsized entry is a registry the size map does
      // not cover yet; it keeps the pre-policy behaviour rather than a guess
      // (AoE II's unsized EULA.RTF streamed into a non-parking reader once).
      if (size === null) return file;
      const ext = extensionOf(fileUrl(file));
      if (EAGER_EXTENSIONS.has(ext)) return file;
      if (persist.length && vfsPathsOf(file).some(path => persist.some(re => re.test(path)))) return file;
      // httpRange, not a sized loadMode 'lazy': a sized loadMode entry
      // refuses to fall back when the host answers a Range request with 200,
      // which a plain static server does (the launch then stalls on
      // "Download problem"). The size rides along so host.js can mount it
      // with no HEAD, and accept a 200 as the whole file.
      const base = typeof file === 'string' ? { url: file } : { ...file };
      return { ...base, httpRange: true, size };
    });
    if (preloadWholeBytes > PRELOAD_WHOLE_WARN_BYTES) {
      const total = `${(preloadWholeBytes / (1024 * 1024)).toFixed(0)}MB`;
      console.warn(`[files] ${(app && app.id) || 'app'}: preloadAssets makes ${total} `
        + `required at launch with no measured ranges (${preloadWhole.join(', ')}). `
        + 'Run tools/mbaa-texture-census.js on these archives and declare '
        + 'preloadRanges to preload only the bytes the guest reads before it can park.');
      summary.preloadWholeBytes = preloadWholeBytes;
    }
    // One entry that cannot be pinned is otherwise invisible: the launch looks
    // exactly like one where the preload was never declared, which is how a
    // typo in `preloadAssets` or a missing `.size` turns into a mid-battle
    // Loading window that nobody connects back to the policy.
    if (preloadSkipped.length) {
      console.warn(`[files] ${(app && app.id) || 'app'}: preloadAssets names `
        + `${preloadSkipped.length} file(s) with no known size (${preloadSkipped.join(', ')}); `
        + 'they stream as before. A preload needs a measured size to pin anything.');
      summary.preloadSkipped = preloadSkipped;
    }
    if (rangesRefused.length) {
      console.warn(`[files] ${(app && app.id) || 'app'}: preloadRanges refused `
        + `${rangesRefused.length} list(s) measured against a different file `
        + `(${rangesRefused.join(', ')}); those fall back to a whole-file preload. `
        + 'Re-run tools/mbaa-texture-census.js against the file the manifest declares.');
      summary.preloadRangesRefused = rangesRefused;
    }
    // A declared table whose keys matched no preloaded file is the quietest
    // failure in this whole policy: launch stays at a gigabyte and the census
    // output beside it looks correct. Name the keys that were never consulted.
    if (app && app.preloadRanges && typeof app.preloadRanges === 'object' &&
        rangesUsed.size === 0 && preload.length) {
      // A key that DID match but whose list was refused is already reported
      // above; only the keys nothing ever consulted are news here.
      const keys = Object.keys(app.preloadRanges).filter(key =>
        !rangesRefusedKeys.has(String(key).replace(/[?#].*$/, '').replace(/^.*[\\/]/, '').toLowerCase()));
      if (keys.length) {
        console.warn(`[files] ${(app && app.id) || 'app'}: preloadRanges declares `
          + `${keys.join(', ')} but no preloaded file matched those keys; the ranges are unused.`);
        summary.preloadRangesUnused = keys;
      }
    }
    return finish(out, 'lazy');
  }

  // `preloadAssets` entries name files the same way `persistFiles` does, plus
  // the two names an app author actually has in hand: the guest path
  // (`c:\0002.p`) and the published URL leaf (`0002.p`, or `0002.p.part000`
  // in a deploy tree). A trailing `/` or a bare name with no dot is read as a
  // prefix, so `assets/raw/MBAACC/` preloads the whole tree.
  function preloadMatchers(app) {
    const list = app && Array.isArray(app.preloadAssets) ? app.preloadAssets.slice() : [];
    // A manifest may carry its own textures list (the app tree travels with
    // the media, so the list belongs beside it): `preloadAssets` at the top
    // level, or `registry.preloadAssets`. Both are just more names.
    if (app && app._localManifestPreload && Array.isArray(app._localManifestPreload))
      list.push(...app._localManifestPreload);
    return list.filter(item => typeof item === 'string' && item)
      .map(item => preloadMatcher(item));
    // An entry with a separator in it is a URL or a repo path, not a guest
    // path, and no files[] entry's VFS path contains that prefix: it matches
    // the END of the candidate instead. A directory (trailing separator) or
    // anything with a wildcard matches a tail-prefix, so `assets/raw/MBAACC/`
    // takes the whole tree. A bare leaf keeps the exact-path rule shared with
    // persistFiles, where the author really does mean the guest's path.
    function preloadMatcher(item) {
      const escape = text => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.');
      if (!/[\\/]/.test(item)) return patternRegex(item);
      const dir = /[\\/]$/.test(item);
      const tail = normalizePath(item).replace(/^[a-z]:\\?/, '');
      const body = escape(tail) + (dir ? '.*' : '');
      return new RegExp('(?:^|[\\\\/])' + body + '$');
    }
  }
  // A preloadAssets entry is authored by a human, so it may name the file by
  // its guest path (c:\0002.p), by its published URL (assets/raw/MBAACC/0002.p)
  // or by leaf alone (0002.p). The VFS paths a files[] entry carries are NOT
  // the URL: matching one against the other silently preloads nothing, which
  // is why the URL leaf and the raw URL are both candidates here.
  function preloadCandidates(file) {
    const paths = vfsPathsOf(file);
    const url = fileUrl(file);
    // Every name the author might have written for this file. The URL leaf,
    // the URL itself, and the guest path the URL WOULD map to when it keeps
    // its directories (`assets/raw/MBAACC/0002.p` -> `c:\\assets\\raw\\mbaacc\\0002.p`)
    // are all legitimate spellings, and matching only the VFS path silently
    // preloads nothing for a registry whose vfsPath is flattened.
    paths.push(url.toLowerCase().replace(/^.*\//, ''));
    paths.push(url.toLowerCase());
    paths.push(normalizePath(url));
    if (typeof file === 'object' && file && Array.isArray(file.vfsPaths))
      for (const path of file.vfsPaths) paths.push(String(path).toLowerCase());
    return paths;
  }
  // `preloadRanges` on the APP is an object keyed by file, or a function
  // (file, size) -> ranges. Ranges may be the {schemaVersion, size, ranges}
  // object tools/io-range-census.js --emit writes, or a bare array of pairs.
  // A list measured against a different size is refused here rather than at
  // mount time: pinning the wrong bytes is worse than not preloading.
  function rangeListFor(app) {
    const table = app && app.preloadRanges;
    const used = new Set(), refused = [], refusedKeys = new Set();
    // Resolve a table key the same way a preloadAsset name resolves: an exact
    // key, the URL, then the URL leaf in EITHER case. `leaf` used to be
    // compared case-sensitively, so `{"0002.P": ...}` (or any census file
    // renamed on the way in) silently matched nothing and the archive fell
    // back to a whole-file preload -- a 900MB launch from a key that looks
    // right. A refusal is reported by the caller rather than swallowed.
    const at = (key) => (key && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);
    const resolve = (file, size) => {
      if (!table) return null;
      const url = fileUrl(file);
      const leaf = url.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '');
      let value = typeof table === 'function' ? table(file, size) : null;
      if (value === null && typeof table !== 'function') {
        value = at(leaf) || at(url) || at(url.replace(/[?#].*$/, '')) || null;
        if (value === null) {
          // Last resort: a case-insensitive match on the leaf, which is the
          // spelling a Windows-minded author writes.
          const lower = leaf.toLowerCase();
          for (const key of Object.keys(table)) {
            if (key.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '').toLowerCase() === lower) {
              value = table[key];
              break;
            }
          }
        }
      }
      if (!value) return null;
      const list = Array.isArray(value) ? value : value.ranges;
      if (!Array.isArray(list) || !list.length) return null;
      // Measured on other bytes: refuse the list (pinning the wrong ranges is
      // worse than pinning none) and say which file disagreed, because the
      // caller's next move -- re-run the census against the deployed file --
      // depends on knowing it was the size and not the key that missed.
      if (!Array.isArray(value) && Number.isSafeInteger(value.size) &&
          Number.isSafeInteger(size) && value.size !== size) {
        refused.push(`${leaf || url} (declared ${value.size}B, file is ${size}B)`);
        refusedKeys.add((leaf || url).toLowerCase());
        return null;
      }
      used.add(leaf || url);
      return { schemaVersion: 1, ...(Number.isSafeInteger(size) ? { size } : {}), ranges: list };
    };
    return Object.assign(resolve, { used, refused, refusedKeys });
  }

  // A registry entry can carry `iniSet: {Section: {Key: 'value'}}` to change
  // keys in a mounted INI file -- what a player does in the game's own
  // settings screen, decided once in the registry so both hosts mount the
  // same file. Deus Ex's installer writes SoftDrv as its renderer; UE1 has no
  // command-line override for it. Each key is replaced in place, or appended
  // to its section (the section is appended when absent); line endings and
  // every other byte are kept. Bytes are treated as Latin-1, as UE1 does.
  function applyIniSet(bytes, iniSet) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const sectionOf = name => lines.findIndex(line =>
      line.trim().toLowerCase() === '[' + name.toLowerCase() + ']');
    for (const [section, keys] of Object.entries(iniSet)) {
      let head = sectionOf(section);
      if (head < 0) {
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push('', '[' + section + ']', '');
        head = lines.length - 2;
      }
      for (const [key, value] of Object.entries(keys)) {
        let end = head + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
        const want = key.toLowerCase();
        const at = lines.slice(head + 1, end).findIndex(line =>
          line.split('=')[0].trim().toLowerCase() === want);
        if (at >= 0) {
          lines[head + 1 + at] = key + '=' + value;
        } else {
          // After the section's last non-blank line.
          let tail = end;
          while (tail > head + 1 && lines[tail - 1].trim() === '') tail--;
          lines.splice(tail, 0, key + '=' + value);
        }
      }
    }
    const out = lines.join(eol);
    const result = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) result[i] = out.charCodeAt(i) & 0xFF;
    return result;
  }

  const api = {
    applyIniSet,
    APP_EAGER_BYTES,
    EAGER_EXTENSIONS,
    normalizeLazyFiles,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.appFiles = api;
})();
