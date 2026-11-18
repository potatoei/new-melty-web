// Cloudflare Worker: serve the chunked MBAACC asset tree out of Workers KV with
// the HTTP semantics the engine actually depends on.
//
// WHY A WORKER AND NOT A BARE BUCKET
//
// lib/byte-provider.js will not mount a lazy archive unless the host answers a
// HEAD with `Accept-Ranges: bytes` and a `Content-Length`, and it rejects a
// `206` whose `Content-Range` disagrees with the manifest size. Workers KV has
// NO native range support: a KV value comes back whole. So this Worker does the
// three things the loader needs and nothing else:
//
//   1. HEAD/GET  -> Accept-Ranges, Content-Length, stable ETag from the split's
//                   SHA-256, so a sized entry mounts without a second HEAD.
//   2. GET Range -> 206 with an exact Content-Range, sliced out of the value
//                   in the isolate. This is why the KV value is fetched with
//                   metadata: the part must be small enough to hold (the
//                   chunker keeps every part under 25 MiB, which is also the
//                   KV per-value limit).
//   3. CORS      -> The guest page is cross-origin from the asset host in the
//                   dev-server setup, and a Range request is a preflighted one
//                   because of the Range header. Without the preflight answer
//                   below every read fails as a CORS error, which the loader
//                   reports as "does not advertise Accept-Ranges".
//
// WHAT THIS IS NOT: a KV value over 25 MiB cannot be stored at all, so a
// part larger than that fails at upload time, not here. tools/cloudflare-chunk.js
// enforces the bound before it writes a part.

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    // Range is the one request header a cross-origin read needs.
    'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Range',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Max-Age': '86400',
    // A Range response is useless to the page unless these are readable.
    'Access-Control-Expose-Headers':
      'Accept-Ranges, Content-Length, Content-Range, ETag, Cache-Control',
    ...extra,
  };
}

// One `bytes=a-b` range. Multipart ranges are not needed by any client here and
// are refused the way a single-range server may: with a 200 (the whole body).
function parseRange(header, size) {
  const match = RANGE_RE.exec(String(header || '').trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  let start, end;
  if (first === '') {
    // `bytes=-N`: the LAST N bytes.
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Number(last);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return { unsatisfiable: true };
  }
  if (end >= size) end = size - 1;
  return { start, end };
}

async function lookup(env, key) {
  const result = await env.ASSETS.getWithMetadata(key, 'arrayBuffer');
  if (!result || result.value === null || result.value === undefined) return null;
  const bytes = new Uint8Array(result.value);
  const meta = result.metadata || {};
  return {
    bytes,
    // The manifest's size is authoritative when present: a truncated upload is
    // then a 500 instead of a subtly short 200.
    size: Number.isSafeInteger(meta.size) ? meta.size : bytes.byteLength,
    sha256: meta.sha256 || null,
  };
}

function respond(body, status, headers) {
  return new Response(body, { status, headers: corsHeaders(headers) });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return respond(null, 204, {});
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return respond('method not allowed\n', 405, { Allow: 'GET, HEAD, OPTIONS' });
    }

    const url = new URL(request.url);
    // Keys are the URL path with the leading slash removed, so the split tree
    // uploads as `mbaa/0002.p.part000` and is fetched as the same path.
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!key || key.includes('..')) return respond('bad key\n', 400, {});
    if (key.split('/').length > 8) return respond('bad key\n', 400, {});

    const asset = await lookup(env, key);
    if (!asset) return respond('not found\n', 404, { 'Cache-Control': 'no-store' });

    const etag = asset.sha256 ? `"${asset.sha256}"` : null;
    const common = {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(asset.size),
      // Immutable objects named by content hash: a part never changes, so the
      // browser may keep it for the life of the cache.
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...(etag ? { ETag: etag } : {}),
    };

    if (etag && request.headers.get('if-none-match') === etag) {
      return respond(null, 304, common);
    }

    if (asset.size !== asset.bytes.byteLength) {
      // A part whose stored length disagrees with the manifest would answer a
      // Range with the wrong bytes; say so instead.
      return respond('part length disagrees with manifest\n', 500,
        { 'Cache-Control': 'no-store' });
    }

    const rangeHeader = request.headers.get('range');
    if (!rangeHeader) {
      return respond(request.method === 'HEAD' ? null : asset.bytes, 200, common);
    }

    const range = parseRange(rangeHeader, asset.size);
    if (range && range.unsatisfiable) {
      return respond(null, 416, {
        ...common,
        'Content-Range': `bytes */${asset.size}`,
      });
    }
    if (!range) {
      // Unparseable Range: serve the whole representation, which is what the
      // HTTP spec allows and what a 200-with-acceptWhole mount expects.
      return respond(request.method === 'HEAD' ? null : asset.bytes, 200, common);
    }

    const slice = asset.bytes.subarray(range.start, range.end + 1);
    return respond(request.method === 'HEAD' ? null : slice, 206, {
      ...common,
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${range.start}-${range.end}/${asset.size}`,
    });
  },
};

// Exported for tools/cloudflare-chunk-test.js: the range parser is the piece
// whose off-by-one would corrupt every archive read, so it is tested directly
// rather than only through a request.
export { parseRange, corsHeaders };
