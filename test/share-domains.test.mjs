// 分享域名白名单：B站 官方短链备用域名要认，冒充域名要拒。运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../_worker.js', import.meta.url)), 'utf8');
const file = join(mkdtempSync(join(tmpdir(), 'bili-')), 'w.mjs');
writeFileSync(file, src);
const mod = (await import(file)).default;

function memKV() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => void m.set(k, String(v)), delete: async (k) => void m.delete(k), list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }) };
}
let calls = [];
globalThis.fetch = async (u) => {
  calls.push(String(u && u.url ? u.url : u));
  return new Response('upstream broken', { status: 500 });
};
let n = 0;
async function parse(text) {
  calls = [];
  const env = { TURNSTILE_DISABLED: '1', FEEDBACK_KV: memKV(), REDFOX_API_KEY: 'fake', ASSETS: { fetch: async () => new Response('asset') } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const req = new Request('https://bilibilishipinjiexi.pages.dev/api/parse?url=' + encodeURIComponent(text), { headers: { 'cf-connecting-ip': '198.51.100.' + (++n) } });
  const r = await mod.fetch(req, env, ctx);
  return { status: r.status, body: await r.text(), calls };
}
const REJECT = '只支持 B站 链接';

for (const link of [
  'https://b23.tv/aB12cD3',
  'https://bili2233.cn/aB12cD3',
  'https://bili22.cn/aB12cD3',
  'https://bili23.cn/aB12cD3',
  'https://bili33.cn/aB12cD3',
  'https://www.bilibili.com/video/BV1GJ411x7h7',
]) {
  test('接受 ' + link, async () => {
    const r = await parse('【标题】 ' + link);
    assert.ok(!r.body.includes(REJECT), r.status + ' ' + r.body.slice(0, 160));
  });
}

for (const link of [
  'https://bili22.cn.evil.example/x',
  'https://notbili33.cn/x',
  'https://bili23.cn-evil.com/x',
  'https://acg.tv/x',
  'https://bili24.cn/x',
  'https://evil.example/?u=https://b23.tv/x',
]) {
  test('拒绝冒充/非官方域名 ' + link, async () => {
    const r = await parse(link);
    assert.equal(r.status, 400, r.body.slice(0, 160));
    assert.ok(r.body.includes(REJECT), r.body.slice(0, 160));
    assert.equal(r.calls.length, 0, '不该调上游：' + r.calls.join(','));
  });
}

test('拒绝时的提示写出新的短链域名', async () => {
  const r = await parse('https://bili24.cn/x');
  const j = JSON.parse(r.body);
  for (const d of ['bilibili.com', 'b23.tv', 'bili2233.cn', 'bili22.cn', 'bili23.cn', 'bili33.cn']) assert.ok(j.error.includes(d), d + ' 不在提示里：' + j.error);
});
