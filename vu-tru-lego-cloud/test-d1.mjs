// Automated CI test suite cho Cloudflare D1 (SQLite) Functions
// Chạy bằng: node vu-tru-lego-cloud/test-d1.mjs (Yêu cầu Node.js >= 22.5 có sẵn node:sqlite)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as productsHandler } from './functions/api/products.js';
import { onRequest as uploadHandler } from './functions/api/upload.js';
import { onRequest as imageHandler } from './functions/api/image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlite = new DatabaseSync(':memory:');
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
sqlite.exec(schema);

const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let bound = [];
    const normalize = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    const runner = {
      bind(...args) {
        bound = args.map(normalize);
        return runner;
      },
      async all() {
        return { results: stmt.all(...bound) };
      },
      async first() {
        return stmt.get(...bound) ?? null;
      },
      async run() {
        const info = stmt.run(...bound);
        return { success: true, meta: info };
      }
    };
    return runner;
  }
};

const env = { DB, ADMIN_TOKEN: 'ci-test-admin-token' };

// 1. GET empty products
let res = await productsHandler({
  request: new Request('https://example.com/api/products'),
  env
});
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), []);

// 2. Upload image without token -> 401
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const dataUrl = `data:image/png;base64,${tinyPngBase64}`;
res = await uploadHandler({
  request: new Request('https://example.com/api/upload', {
    method: 'POST',
    body: JSON.stringify({ dataUrl, fileName: 'lego-car' })
  }),
  env
});
assert.equal(res.status, 401);

// 3. Upload image with valid token -> 201
res = await uploadHandler({
  request: new Request('https://example.com/api/upload', {
    method: 'POST',
    headers: { 'x-admin-token': 'ci-test-admin-token' },
    body: JSON.stringify({ dataUrl, fileName: 'lego-car' })
  }),
  env
});
assert.equal(res.status, 201);
const { url: imgUrl1 } = await res.json();
assert.match(imgUrl1, /^\/api\/image\?id=/);

// 4. Fetch uploaded image via /api/image
res = await imageHandler({
  request: new Request(`https://example.com${imgUrl1}`),
  env
});
assert.equal(res.status, 200);
assert.equal(res.headers.get('content-type'), 'image/png');
const imgBytes = new Uint8Array(await res.arrayBuffer());
assert.equal(Buffer.from(imgBytes).toString('base64'), tinyPngBase64);

// 5. Create product with image
res = await productsHandler({
  request: new Request('https://example.com/api/products', {
    method: 'POST',
    headers: { 'x-admin-token': 'ci-test-admin-token' },
    body: JSON.stringify({
      name: 'Porsche 911 GT3 RS',
      code: 'VTL-911',
      price: 1590000,
      category: 'supercar',
      desc: 'Xe lắp ráp tỉ lệ 1:8',
      pieces: '2704 mảnh',
      age: '16+',
      size: '57 x 25 x 17 cm',
      weight: '2.5 kg',
      images: [imgUrl1]
    })
  }),
  env
});
assert.equal(res.status, 201);
const created = await res.json();
assert.equal(created.name, 'Porsche 911 GT3 RS');
assert.deepEqual(created.images, [imgUrl1]);

// 6. Update product replacing image -> old image cleaned up from SQLite
res = await productsHandler({
  request: new Request('https://example.com/api/products', {
    method: 'PUT',
    headers: { 'x-admin-token': 'ci-test-admin-token' },
    body: JSON.stringify({
      ...created,
      price: 1490000,
      images: []
    })
  }),
  env
});
assert.equal(res.status, 200);
const updated = await res.json();
assert.equal(updated.price, 1490000);

res = await imageHandler({
  request: new Request(`https://example.com${imgUrl1}`),
  env
});
assert.equal(res.status, 404);

// 7. Delete product
res = await productsHandler({
  request: new Request(
    `https://example.com/api/products?id=${encodeURIComponent(created.id)}`,
    {
      method: 'DELETE',
      headers: { 'x-admin-token': 'ci-test-admin-token' }
    }
  ),
  env
});
assert.equal(res.status, 200);

console.log('✅ All Cloudflare D1 SQLite API tests passed!');
