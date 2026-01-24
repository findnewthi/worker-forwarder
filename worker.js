/**
 * @param {import("@cloudflare/workers-types").Request} request
 * @param {{KV_CONFIG: import("@cloudflare/workers-types").KVNamespace}} env
 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // 预检请求直接放行（对网页跨域更友好；不影响 WebSocket）
      if (request.method === "OPTIONS") {
        return handleOptions();
      }

      // 单次请求内 KV 懒加载（带缓存）
      const kv = createKvLazy(env);

      // --- 路由分发：fetch 内只做判断 ---
      if (url.pathname === "/hostmap/update" && request.method === "GET") {
        return handleHostmapUpdate(url, kv, env);
      }

      if (url.pathname === "/hostmap" && request.method === "GET") {
        return handleHostmapGet(url, kv);
      }

      // 默认：转发逻辑（兼容 WS）
      return handleProxy(request, url, kv);
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
 * @param {ReturnType<typeof createKvLazy>} kv
 * @param {{KV_CONFIG: import("@cloudflare/workers-types").KVNamespace}} env
 */
async function handleHostmapUpdate(url, kv, env) {
  const inputPassword = url.searchParams.get("password");
  const password = await kv.getPassword();

  if (!password) return textResponse("KV中未找到password配置", 500);
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
 * @param {ReturnType<typeof createKvLazy>} kv
 */
async function handleHostmapGet(url, kv) {
  const inputPassword = url.searchParams.get("password");
  const password = await kv.getPassword();

  if (!password) return textResponse("KV中未找到password配置", 500);
  if (inputPassword !== password) return new Response(null, { status: 403 });

  const hostmap = await kv.getHostmap();
  if (!hostmap) return textResponse("KV中未找到hostmap配置或格式错误", 500);

  return new Response(JSON.stringify(hostmap, null, 2), {
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

/**
 * 转发入口：先判断是否强制路由；否则走 hostmap
 * @param {Request} request
 * @param {URL} url
 * @param {ReturnType<typeof createKvLazy>} kv
 */
async function handleProxy(request, url, kv) {
  // ✅ 强制路由从 header 取（HTTP header 名不区分大小写）
  const ROUTE_TARGET_HEADER = "Route-Target-Cf-My";
  const ROUTE_PASSWORD_HEADER = "Route-Password-Cf-My";

  const overrideTarget = request.headers.get(ROUTE_TARGET_HEADER);
  const overridePassword = request.headers.get(ROUTE_PASSWORD_HEADER);

  // 1) 强制路由：出现 ROUTE_TARGET_HEADER 才读 password 校验
  if (overrideTarget && overrideTarget.trim()) {
    const password = await kv.getPassword();
    if (!password) return textResponse("KV中未找到password配置", 500);

    // 密码不对：直接 403（更安全）
    if (overridePassword !== password) return new Response(null, { status: 403 });

    const t = parseTarget(overrideTarget.trim());

    // 强制路由：必须删除敏感 header（避免泄露）
    const stripHeaders = [ROUTE_TARGET_HEADER, ROUTE_PASSWORD_HEADER];
    return proxyToTarget(request, url, t, { stripHeaders });
  }

  // 2) 非强制路由：此时才加载 hostmap
  const hostmap = await kv.getHostmap();
  if (!hostmap) return textResponse("KV中未找到hostmap配置或格式错误", 500);

  const curhost = url.host;         // 可能含端口
  const curhostname = url.hostname; // 不含端口
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
 * 共用转发逻辑：HTTP + WebSocket 都能透传（直接 fetch(modifiedRequest)）
 *
 * @param {Request} request
 * @param {URL} url
 * @param {{ protocol: 'http'|'https', hostname: string, port: string|null }} target
 * @param {{ stripHeaders?: string[] }} [opts]
 */
async function proxyToTarget(request, url, target, opts = {}) {
  const targetUrl = new URL(url);
  targetUrl.protocol = target.protocol + ":";
  targetUrl.hostname = target.hostname;
  targetUrl.port = target.port ?? "";

  // 复制 headers，但删除 Host（让 fetch 根据 targetUrl 自动生成正确 Host）
  const headers = new Headers(request.headers);
  headers.delete("Host");

  // 强制路由时：删除自定义敏感头（避免泄露）
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

  return modifiedResponse;
}


// =====================
// KV lazy cache (per request)
// =====================

/**
 * 单次请求内的 KV 懒加载缓存
 * @param {{KV_CONFIG: import("@cloudflare/workers-types").KVNamespace}} env
 */
function createKvLazy(env) {
  /** @type {string|null|undefined} */
  let _password;
  /** @type {Record<string, string>|null|undefined} */
  let _hostmap;

  return {
    async getPassword() {
      if (_password !== undefined) return _password;
      _password = await env.KV_CONFIG.get("password", { type: "text" });
      return _password;
    },

    async getHostmap() {
      if (_hostmap !== undefined) return _hostmap;

      const hostmapJson = await env.KV_CONFIG.get("hostmap", { type: "text" });
      if (!hostmapJson) {
        _hostmap = null;
        return _hostmap;
      }

      try {
        const parsed = JSON.parse(hostmapJson);
        if (typeof parsed !== "object" || parsed === null) {
          _hostmap = null;
          return _hostmap;
        }
        _hostmap = parsed;
        return _hostmap;
      } catch {
        _hostmap = null;
        return _hostmap;
      }
    },
  };
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

/**
 * 解析 target，支持：
 * - "example.com"
 * - "1.2.3.4"
 * - "example.com:8080"
 * - "1.2.3.4:8080"
 * - "http://example.com:8080"
 * - "https://example.com"
 *
 * 规则：
 * - 若显式提供 http/https，则优先使用
 * - 否则：有端口 => http；无端口 => https
 *
 * @param {string} raw
 * @returns {{ protocol: 'http'|'https', hostname: string, port: string|null }}
 */
function parseTarget(raw) {
  const s = String(raw).trim();

  // 显式 scheme：优先使用
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    let hostname = u.hostname;

    // 如果 URL 里写的是 IPv4，也转成 sslip.io
    if (isIPv4(hostname)) {
      hostname = `${hostname.replace(/\./g, "-")}.sslip.io`;
    }

    const protocol = u.protocol === "http:" ? "http" : "https";
    return { protocol, hostname, port: u.port ? u.port : null };
  }

  // host[:port]
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

  // ⭐ 裸 IPv4：自动转成 xxx-xxx-xxx-xxx.sslip.io
  if (isIPv4(hostname)) {
    hostname = `${hostname.replace(/\./g, "-")}.sslip.io`;
  }

  // 规则：有端口 => http；无端口 => https
  const protocol = port ? "http" : "https";
  return { protocol, hostname, port };
}


function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Route-Target-Cf-My, Route-Password-Cf-My",
  };
}

/**
 * 从 KV 中读取 map_url 并更新 hostmap
 * @param {{ KV_CONFIG: import("@cloudflare/workers-types").KVNamespace }} env
 */
async function updateHostmapFromRemote(env) {
  const mapUrl = await env.KV_CONFIG.get("map_url", { type: "text" });
  if (!mapUrl) {
    throw new Error("KV中未找到map_url配置");
  }

  const mapResponse = await fetch(mapUrl);
  if (!mapResponse.ok) {
    throw new Error("无法获取新的hostmap配置");
  }

  const newHostmap = await mapResponse.json();
  if (typeof newHostmap !== "object" || newHostmap === null) {
    throw new Error("新配置格式错误");
  }

  await env.KV_CONFIG.put("hostmap", JSON.stringify(newHostmap));
}

// =====================
// Direct-IP workaround
// =====================

/** 判断是否为 IPv4 */
function isIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every(x => {
    const n = Number(x);
    return n >= 0 && n <= 255;
  });
}
