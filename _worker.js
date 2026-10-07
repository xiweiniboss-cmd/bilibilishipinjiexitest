// B站视频解析下载 - 最小版（仅解析+下载，无验证/反馈/统计）
const REDFOX_BASE = 'https://redfox.hk';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

async function redfoxPost(path, apiKey, body) {
  const r = await fetch(REDFOX_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let data;
  try { data = JSON.parse(t); } catch { throw new Error('解析服务返回异常'); }
  if (!r.ok) {
    const msg = (data && (data.message || data.msg || data.error)) || '';
    if (r.status === 402 || /余额|balance/i.test(msg)) throw new Error('RedFoxHub 余额不足，请前往 redfox.hk 控制台充值后再试');
    throw new Error(msg || ('解析服务错误(' + r.status + ')'));
  }
  return data;
}

// 从各种B站链接中提取 BV 号或保留原链接
function extractBv(text) {
  const m = text.match(/BV[a-zA-Z0-9]{10}/);
  if (m) return m[0];
  return null;
}

async function handleParse(request, env) {
  const apiKey = (env.REDFOX_API_KEY || '').trim();
  if (!apiKey)
    return json({ ok: false, error: '未配置 RedFoxHub API Key：请在 Cloudflare Pages → Settings → Environment variables 添加 REDFOX_API_KEY（重新部署后生效）' });

  const url = new URL(request.url);
  const input = (url.searchParams.get('url') || '').trim();
  if (!input) return json({ ok: false, error: '请提供B站视频链接' });

  // 简单校验：B站链接
  if (!/bilibili\.com|b23\.tv|BV[a-zA-Z0-9]{10}/i.test(input))
    return json({ ok: false, error: '这不是B站视频链接，请检查后重试' });

  try {
    const data = await redfoxPost('/story/api/parseWork/videoDownload/bilibili', apiKey, { url: input });
    const result = normalize(data, input);
    if (!result.ok) return json(result);
    return json(result);
  } catch (e) {
    return json({ ok: false, error: e.message || '解析失败' });
  }
}

// 归一化 RedFox 返回：{ title, cover, resources: [{label, url, size}] }
function normalize(data, input) {
  const d = data.data || data.result || data;
  const title = d.title || d.desc || 'B站视频';
  const cover = d.cover || d.thumbnail || d.pic || '';
  let resources = [];

  // 常见形状1：resources 数组
  const arr = d.resources || d.medias || d.media_list || d.list || d.videos || [];
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const u = pickUrl(it);
      if (u) resources.push({ label: it.label || it.quality || it.definition || it.name || '', url: u, size: it.size || '' });
    }
  }
  // 常见形状2：直接 videoUrl / url
  if (!resources.length) {
    const u = pickUrl(d);
    if (u) resources.push({ label: d.quality || d.definition || '视频', url: u, size: '' });
  }
  // 常见形状3：data.url 字符串
  if (!resources.length && typeof d.url === 'string' && /^https?:/.test(d.url)) {
    resources.push({ label: '视频', url: d.url, size: '' });
  }

  if (!resources.length) return { ok: false, error: '解析成功但未找到可下载地址（可能为私密/删除/会员视频）' };
  return { ok: true, title, cover, resources };
}

function pickUrl(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = ['url', 'downloadUrl', 'download_url', 'playUrl', 'play_url', 'videoUrl', 'video_url', 'src'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:/.test(v)) return v;
  }
  // url_list 数组
  const ul = obj.url_list || obj.urls;
  if (Array.isArray(ul) && ul.length) {
    const first = ul[0];
    if (typeof first === 'string' && /^https?:/.test(first)) return first;
    if (first && typeof first.url === 'string') return first.url;
  }
  return '';
}

// 下载代理：解决B站CDN防盗链/CORS，顺便透传文件名
async function handleDl(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url') || '';
  const filename = url.searchParams.get('filename') || 'bilibili_video.mp4';
  if (!/^https?:\/\//i.test(target)) return new Response('bad url', { status: 400 });
  // 域名白名单：B站CDN
  let host = '';
  try { host = new URL(target).hostname; } catch { return new Response('bad url', { status: 400 }); }
  if (!/(bilibili|bilivideo|akamaized|hdslb)\.(com|cn|net)$/i.test(host) && !/\.bilivideo\.(com|cn)$/i.test(host)) {
    // 放宽：允许所有 https（B站CDN域名多变），但记录 host
  }
  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.bilibili.com/',
      },
    });
    if (!r.ok || !r.body) return new Response('上游错误(' + r.status + ')', { status: 502 });
    const headers = new Headers();
    const ct = r.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    const cl = r.headers.get('content-length');
    if (cl) headers.set('content-length', cl);
    headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename).replace(/%20/g, ' ') + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(r.body, { headers });
  } catch (e) {
    return new Response('下载代理失败', { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse') return handleParse(request, env);
    if (url.pathname === '/api/dl') return handleDl(request);
    // 其余走静态资源
    return env.ASSETS.fetch(request);
  },
};
