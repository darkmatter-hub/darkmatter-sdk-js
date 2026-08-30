/**
 * The SDK must hash a payload exactly as the server does.
 *
 * Until v1.4.2 this SDK computed no hash at all. It posted the payload and let
 * the server hash whatever arrived, which means nothing about the payload was
 * established before it left the machine. Every DarkMatter page saying the
 * payload is hashed on your machine before transmission was true of the Python
 * SDK and false here, and had to be qualified as Python-only.
 *
 * These vectors were generated from DarkMatter's own src/integrity.js, the
 * implementation the server uses to re-hash and compare. If any of them change,
 * this SDK and the server no longer agree and every commit carrying such a
 * payload is flagged as a hash mismatch by the service that asked the client to
 * compute it.
 *
 * Run: node test.js
 */
'use strict';

const assert  = require('node:assert');
const fs      = require('node:fs');
const path    = require('node:path');
const { canonicalize, hashPayload } = require('./src/index.js');

let passed = 0, failed = 0;
const pending = [];

// A test may return a promise. The first version of check() ignored that and
// printed ok before the assertions inside had run, so tests passed with the
// feature they covered switched off. Anything returned is awaited before the
// summary.
function check(label, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(out.then(
        function () { console.log('  ok    ' + label); passed++; },
        function (e) { console.error('  FAIL  ' + label + String.fromCharCode(10) + '          ' + e.message); failed++; }
      ));
      return;
    }
    console.log('  ok    ' + label); passed++;
  } catch (e) {
    console.error('  FAIL  ' + label + String.fromCharCode(10) + '          ' + e.message); failed++;
  }
}

console.log('\nCanonicalization matches the server');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-vectors.json'), 'utf8'));
assert(vectors.length > 0, 'no vectors');

for (const v of vectors) {
  check('canonical form: ' + v.label, () => {
    assert.strictEqual(canonicalize(v.payload), v.canonical);
  });
  check('hash: ' + v.label, () => {
    assert.strictEqual(hashPayload(v.payload), v.hash);
  });
}

console.log('\nProperties the canonical form has to have');

check('key order does not depend on input order', () => {
  const a = { a: 1, '\u{1F600}': 'x', '！': 'y' };
  const b = { '！': 'y', '\u{1F600}': 'x', a: 1 };
  assert.strictEqual(hashPayload(a), hashPayload(b));
});

check('an astral key sorts below a BMP key, as UTF-16 requires', () => {
  // U+1F600 is the surrogate pair D83D DE00, so it sorts below U+FF01 by code
  // unit and above it by code point. Python's sorted() gets this wrong; this
  // is the case that proves the two implementations agree above the BMP.
  const out = canonicalize({ a: 1, '\u{1F600}': 'x', '！': 'y' });
  assert(out.indexOf('\u{1F600}') < out.indexOf('！'), out);
});

check('null is kept and undefined is dropped', () => {
  assert.strictEqual(canonicalize({ a: null }), '{"a":null}');
  assert.strictEqual(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

check('no whitespace anywhere', () => {
  const c = canonicalize({ a: 1, b: [1, 2], c: { d: 'e f' } });
  assert.strictEqual(c, '{"a":1,"b":[1,2],"c":{"d":"e f"}}');
});

check('non-finite numbers are rejected rather than silently changed', () => {
  assert.throws(() => canonicalize({ a: NaN }), /non-finite/);
  assert.throws(() => canonicalize({ a: Infinity }), /non-finite/);
});

console.log('\nEvery commit path sends the hash');

check('both commit builders include payload_hash', () => {
  // The module function and the class method had identical bodies. A hash added
  // to one and not the other would ship half the fix, so both go through
  // buildCommitBody and this checks the source rather than trusting that.
  const src = fs.readFileSync(path.join(__dirname, 'src/index.js'), 'utf8');
  const senders = (src.match(/'\/api\/commit'/g) || []).length;
  const builders = (src.match(/buildCommitBody\(/g) || []).length;
  assert(senders >= 2, 'expected both commit paths, found ' + senders);
  // one definition + one call per sender
  assert(builders >= senders + 1,
    'a commit path does not go through buildCommitBody: ' + builders + ' uses for ' + senders + ' senders');
  assert(/payload_hash: hashPayload\(payload\)/.test(src),
    'buildCommitBody must set payload_hash from hashPayload');
});

console.log('');
console.log('Call shapes the documentation teaches');

check('commit accepts an options object', () => {
  // The quickstart taught commit({ payload, parentId }) while the SDK only
  // took positional arguments, so the example passed the options object as
  // toAgentId, left payload undefined, and threw inside canonicalize.
  var seen = null;
  var realFetch = global.fetch;
  global.fetch = async function (u, o) {
    seen = JSON.parse(o.body);
    return { ok: true, status: 200, json: async function () { return { id: 'ctx_x' }; } };
  };
  process.env.DARKMATTER_API_KEY = process.env.DARKMATTER_API_KEY || 'test';
  return require('./src/index.js')
    .commit({ payload: { a: 1 }, parentId: 'ctx_p' })
    .then(function () {
      global.fetch = realFetch;
      assert.deepStrictEqual(seen.payload, { a: 1 });
      assert.strictEqual(seen.parentId, 'ctx_p');
      assert.ok(seen.payload_hash, 'the object form must still hash the payload');
    });
});

check('the positional form still works', () => {
  var seen = null;
  var realFetch = global.fetch;
  global.fetch = async function (u, o) {
    seen = JSON.parse(o.body);
    return { ok: true, status: 200, json: async function () { return { id: 'ctx_x' }; } };
  };
  return require('./src/index.js')
    .commit(undefined, { a: 1 }, { parentId: 'ctx_p' })
    .then(function () {
      global.fetch = realFetch;
      assert.deepStrictEqual(seen.payload, { a: 1 });
      assert.strictEqual(seen.parentId, 'ctx_p');
    });
});

check('bundle is exported', () => {
  // `import { export }` is a syntax error, so the docs named bundle, which the
  // Python SDK also calls it. Both hit /api/export.
  var m = require('./src/index.js');
  assert.strictEqual(typeof m.bundle, 'function');
  assert.strictEqual(m.bundle, m.export);
});

Promise.all(pending).then(function () {
  console.log('\nPassed: ' + passed + '  Failed: ' + failed);
  process.exit(failed ? 1 : 0);
});
