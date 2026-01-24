---

# Worker Hostmap Router

一个基于 **Workers + KV** 的反向代理 / 路由转发工具，支持：

* 🔀 **按 Host 自动映射转发**
* 🔐 **通过 Header 强制指定转发目标（带密码）**
* 🔄 **远程更新 hostmap 配置**
* 🌐 **HTTP / HTTPS / WebSocket 全兼容**
* 🧠 **KV 懒加载，减少不必要读操作**
* 🧩 **简单、可扩展**

---

## 功能概览

### 1️⃣ Host → Target 自动转发

根据请求的 `Host`，从 KV 中读取 `hostmap`，将请求转发到对应目标服务器。

支持：

* 精确匹配 `host:port`
* 仅 hostname 匹配
* `_default` 兜底规则

---

### 2️⃣ Header 强制路由（最高优先级）

通过请求头**强制指定转发目标**，绕过 hostmap：

```http
Route-Target-Cf-My: example.com:8080
Route-Password-Cf-My: your_password
```

特性：

* ✅ 只有出现 `Route-Target-Cf-My` 才会校验密码
* ❌ 密码错误直接 `403`
* 🚫 自动移除敏感 Header，避免向目标泄露

适合：

* 内部调试
* 私有穿透
* 临时转发

---

### 3️⃣ Hostmap 在线更新

支持从远程 URL 拉取最新 hostmap 并写入 KV。

```http
GET /hostmap/update?password=xxx
```

---

### 4️⃣ Hostmap 查询（带密码）

```http
GET /hostmap?password=xxx
```

返回格式化 JSON，便于调试。

---

### 5️⃣ CORS & WebSocket 支持

* 自动处理 `OPTIONS` 预检
* 对 WebSocket 透明，不影响升级
* 响应统一追加 CORS Header

---

## KV 配置说明

Worker 依赖一个 KV Namespace（示例名：`KV_CONFIG`）。

### 必需的 KV Key

| Key        | 类型     | 说明                       |
| ---------- | ------ | ------------------------ |
| `password` | string | 管理 & 强制路由密码              |
| `hostmap`  | JSON   | 主机映射表                    |
| `map_url`  | string | 远程 hostmap JSON 地址（用于更新） |

---

## hostmap 格式示例

```json
{
  "a.example.com": "1.2.3.4:8080",
  "b.example.com": "https://backend.example.com",
  "example.com": "example.org",
  "_default": "default.example.com"
}
```

### 匹配顺序

1. `host:port`
2. `hostname`
3. `_default`

---

## Target 解析规则

支持以下格式：

```text
example.com
example.com:8080
1.2.3.4
1.2.3.4:8080
http://example.com:8080
https://example.com
```

### 协议判断规则

* 显式 `http://` / `https://` → **优先使用**
* 无 scheme：

  * 有端口 → `http`
  * 无端口 → `https`

---

## API 接口一览

### 🔄 更新 hostmap

```http
GET /hostmap/update?password=xxx
```

成功返回：

```text
hostmap已更新
```

---

### 📄 查看 hostmap

```http
GET /hostmap?password=xxx
```

返回：

```json
{
  "example.com": "1.2.3.4:8080",
  "_default": "default.example.com"
}
```

---

## Header 强制转发示例

```bash
curl https://your-worker.example.com/test \
  -H "Route-Target-Cf-My: 1.2.3.4:8080" \
  -H "Route-Password-Cf-My: your_password"
```

---

## 安全说明

* 强制路由 **必须** 同时提供：

  * `Route-Target-Cf-My`
  * `Route-Password-Cf-My`
* 密码错误直接 `403`
* 自动删除以下 Header：

  * `Host`
  * `Route-Target-Cf-My`
  * `Route-Password-Cf-My`

---

## 部署说明（简要）

1. 创建 Cloudflare Worker
2. 绑定 KV Namespace 为 `KV_CONFIG`
3. 设置 KV 初始值：

   ```text
   password = your_password
   hostmap  = {...}
   map_url  = https://example.com/hostmap.json
   ```
4. 部署 Worker

---

## 适用场景

* 轻量反向代理
* 多域名统一入口
* 内网服务暴露
* WebSocket 穿透
* 自用 / 私有基础设施

---

## License

MIT

---
