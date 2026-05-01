/**
 * @param {Request} request
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 * @param {ExecutionContext} ctx
 */
 
const HOSTMAP_CACHE_TTL = 600; // 单位：秒
const ROUTE_TARGET_HEADER = "Route-Target-Cf-My";
const ROUTE_PASSWORD_HEADER = "Route-Password-Cf-My";

const GLOBAL_CONFIG = {
  HOSTMAP_URL: "",
  PASSWORD: "",
  CLOUDFLARE_API_URL: "",
  CLOUDFLARE_API_KEY: "",
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // 预检请求直接放行（对网页跨域更友好；不影响 WebSocket）
      if (request.method === "OPTIONS") {
        return handleOptions();
      }

      // --- 路由分发：fetch 内只做判断 ---
      if (url.pathname === "/hostmap/update" && request.method === "GET") {
        return handleHostmapUpdate(url, env);
      }

      if (url.pathname === "/hostmap" && request.method === "GET") {
        return handleHostmapGet(url, env);
      }

      // 默认：转发逻辑（兼容 WS）
      return handleProxy(request, url, env);
    } catch (error) {
      return textResponse(`服务器错误: ${error?.message ?? String(error)}`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await updateHostmapFromRemote(env);
          console.log("cron: hostmap 更新成功");
        } catch (e) {
          console.error("cron: hostmap 更新失败:", e);
        }
      })()
    );
  },
};

// =====================
// Route handlers
// =====================

function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * /hostmap/update?password=xxx
 * @param {URL} url
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 */
async function handleHostmapUpdate(url, env) {
  const inputPassword = url.searchParams.get("password");
  const password = getConfigValue(env, "PASSWORD");

  if (!password) return textResponse("未找到password配置", 500);
  if (inputPassword !== password) return new Response(null, { status: 403 });

  try {
    await updateHostmapFromRemote(env);
    return textResponse("hostmap已更新", 200);
  } catch (e) {
    return textResponse(e?.message ?? String(e), 500);
  }
}

/**
 * /hostmap?password=xxx
 * @param {URL} url
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 */
async function handleHostmapGet(url, env) {
  const inputPassword = url.searchParams.get("password");
  const password = getConfigValue(env, "PASSWORD");

  if (!password) return textResponse("未找到password配置", 500);
  if (inputPassword !== password) return new Response(null, { status: 403 });

  try {
    // 使用 fetchHostmap：先读缓存，无则更新再读
    const hostmap = await fetchHostmap(env);
    const customDomains = await fetchCustomDomains(env);
    const payload = {
      hostmaps: hostmap,
      custom_domains: customDomains,
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  } catch (e) {
    return textResponse(e?.message ?? String(e), 500);
  }
}

/**
 * 转发入口：先判断是否强制路由；否则走 hostmap
 * @param {Request} request
 * @param {URL} url
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 */
async function handleProxy(request, url, env) {
  const overrideTarget = request.headers.get(ROUTE_TARGET_HEADER);
  const overridePassword = request.headers.get(ROUTE_PASSWORD_HEADER);

  // 先取 hostmap（任何错误都转成友好响应）
  let hostmap;
  try {
    hostmap = await fetchHostmap(env);
  } catch (e) {
    return textResponse(`hostmap 不可用: ${e?.message ?? "未知错误"}`, 500);
  }

  // 1) 强制路由：出现 ROUTE_TARGET_HEADER 才读 password 校验
  if (overrideTarget && overrideTarget.trim()) {
    const password = getConfigValue(env, "PASSWORD");
    if (!password) return textResponse("未找到password配置", 500);
    if (overridePassword !== password) return new Response(null, { status: 403 });

    const keyOrTarget = overrideTarget.trim();
    const mapped = hostmap && (hostmap[keyOrTarget] ?? hostmap[keyOrTarget.toLowerCase()]);
    const finalRawTarget = mapped ?? keyOrTarget;
    const t = parseTarget(finalRawTarget);

    const stripHeaders = [ROUTE_TARGET_HEADER, ROUTE_PASSWORD_HEADER];
    return proxyToTarget(request, url, t, { stripHeaders });
  }

  // 2) 非强制路由：用 hostmap 做映射
  const curhost = url.host;
  const curhostname = url.hostname;
  const rawTarget = hostmap[curhost] ?? hostmap[curhostname] ?? hostmap._default;

  if (!rawTarget) {
    return textResponse(`未找到主机映射或默认映射: ${curhost}`, 404);
  }

  const t = parseTarget(rawTarget);
  return proxyToTarget(request, url, t);
}

// =====================
// Shared proxy core
// =====================

/**
 * 共用转发逻辑：HTTP + WebSocket 都能透传
 */
async function proxyToTarget(request, url, target, opts = {}) {
  const targetUrl = new URL(url);
  targetUrl.protocol = target.protocol + ":";
  targetUrl.hostname = target.hostname;
  targetUrl.port = target.port ?? "";

  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.set("Origin", `${targetUrl.protocol}//${targetUrl.hostname}`);

  for (const h of opts.stripHeaders ?? []) headers.delete(h);

  const method = request.method;
  const hasBody = !(method === "GET" || method === "HEAD");

  const init = {
    method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  };

  const response = await fetch(new Request(targetUrl.toString(), init));
  const modifiedResponse = new Response(response.body, response);
  const ch = corsHeaders();
  for (const [k, v] of Object.entries(ch)) modifiedResponse.headers.set(k, v);
  modifiedResponse.headers.delete("Link");
  return modifiedResponse;
}

// =====================
// Hostmap 管理（核心改动）
// =====================

function normalizeUrl(u) {
  const s = String(u).trim();
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function getConfigValue(env, key) {
  return env?.[key] || GLOBAL_CONFIG[key] || "";
}

/**
 * 获取 hostmap：先读缓存，不存在则远程更新并重新读取
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 * @returns {Promise<Object>}
 */
async function fetchHostmap(env) {
  const raw = getConfigValue(env, "HOSTMAP_URL");
  if (!raw) throw new Error("HOSTMAP_URL 未配置");

  let mapUrl;
  try {
    mapUrl = normalizeUrl(raw);
    new URL(mapUrl); // 校验必须是合法绝对 URL
  } catch {
    throw new Error("HOSTMAP_URL 配置错误（必须是完整 https URL）");
  }

  const cache = await caches.open("hostmap");
  const cacheKey = new Request(mapUrl, { method: "GET" });

  // 1) 读缓存（缓存解析失败不直接炸，走回源）
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  } catch {
    // ignore, fallback to remote
  }

  // 2) 回源更新（这里抛出的是“可读错误”）
  await updateHostmapFromRemote(env);

  // 3) 再读缓存
  const cached2 = await cache.match(cacheKey);
  if (cached2) return await cached2.json();

  throw new Error("hostmap 更新后仍不可用");
}

/**
 * 从远程获取并更新 hostmap 到缓存
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 */
async function updateHostmapFromRemote(env) {
  const raw = getConfigValue(env, "HOSTMAP_URL");
  if (!raw) throw new Error("HOSTMAP_URL 未配置");

  let mapUrl;
  try {
    mapUrl = normalizeUrl(raw);
    new URL(mapUrl);
  } catch {
    throw new Error("HOSTMAP_URL 配置错误（必须是完整 https URL）");
  }

  let resp;
  try {
    resp = await fetch(mapUrl);
  } catch {
    throw new Error("HOSTMAP_URL 拉取失败（网络错误）");
  }

  if (!resp.ok) {
    throw new Error(`HOSTMAP_URL 拉取失败（HTTP ${resp.status}）`);
  }

  let newHostmap;
  try {
    newHostmap = await resp.json();
  } catch {
    throw new Error("HOSTMAP_URL 返回不是合法 JSON");
  }

  if (typeof newHostmap !== "object" || newHostmap === null) {
    throw new Error("hostmap JSON 必须是对象");
  }

  const cache = await caches.open("hostmap");
  const cacheKey = new Request(mapUrl, { method: "GET" });

  const hostmapResponse = new Response(JSON.stringify(newHostmap), {
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": `public, s-maxage=${HOSTMAP_CACHE_TTL}`,
    },
  });

  await cache.put(cacheKey, hostmapResponse);
}

/**
 * 从 Cloudflare API 拉取自定义域名列表（仅返回 name）
 * @param {{
 *   HOSTMAP_URL?: string,
 *   PASSWORD?: string,
 *   CLOUDFLARE_API_URL?: string,
 *   CLOUDFLARE_API_KEY?: string
 * }} env
 * @returns {Promise<string[]>}
 */
async function fetchCustomDomains(env) {
  const raw = getConfigValue(env, "CLOUDFLARE_API_URL");
  const apiKey = getConfigValue(env, "CLOUDFLARE_API_KEY");

  if (!raw) throw new Error("CLOUDFLARE_API_URL 未配置");
  if (!apiKey) throw new Error("CLOUDFLARE_API_KEY 未配置");

  let apiUrl;
  try {
    apiUrl = normalizeUrl(raw);
    new URL(apiUrl);
  } catch {
    throw new Error("CLOUDFLARE_API_URL 配置错误（必须是完整 https URL）");
  }

  let resp;
  try {
    resp = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch {
    throw new Error("Cloudflare API 拉取失败（网络错误）");
  }

  if (!resp.ok) {
    throw new Error(`Cloudflare API 拉取失败（HTTP ${resp.status}）`);
  }

  let payload;
  try {
    payload = await resp.json();
  } catch {
    throw new Error("Cloudflare API 返回不是合法 JSON");
  }

  const result = Array.isArray(payload?.result) ? payload.result : [];
  return result
    .map(item => (typeof item?.name === "string" ? item.name.trim() : ""))
    .filter(Boolean);
}

// =====================
// Utilities
// =====================

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      ...extraHeaders,
    },
  });
}

function parseTarget(raw) {
  const s = String(raw).trim();

  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    let hostname = u.hostname;
    if (isIPv4(hostname)) {
      hostname = `${hostname.replace(/\./g, "-")}.sslip.io`;
    }
    const protocol = u.protocol === "http:" ? "http" : "https";
    return { protocol, hostname, port: u.port ? u.port : null };
  }

  let hostname = s;
  let port = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon > -1) {
    const maybePort = s.slice(lastColon + 1);
    const maybeHost = s.slice(0, lastColon);
    if (/^\d+$/.test(maybePort) && maybeHost) {
      hostname = maybeHost;
      port = maybePort;
    }
  }

  if (isIPv4(hostname)) {
    hostname = `${hostname.replace(/\./g, "-")}.sslip.io`;
  }

  const protocol = port ? "http" : "https";
  return { protocol, hostname, port };
}

function corsHeaders() {
  const allowHeaders = [
    "Content-Type",
    "Authorization",
    ROUTE_TARGET_HEADER,
    ROUTE_PASSWORD_HEADER,
  ];

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders.join(", "),
  };
}

function isIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every(x => {
    const n = Number(x);
    return n >= 0 && n <= 255;
  });
}
