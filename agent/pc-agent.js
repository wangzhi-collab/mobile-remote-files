const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");

const DEFAULT_SERVER = "https://your-domain.example";
const SERVER_URL = normalizeServerUrl(process.argv[2] || process.env.REMOTE_SERVER || process.env.PHONE_REMOTE_SERVER_URL || DEFAULT_SERVER);
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DIRS = 2500;

const excludedSearchDirs = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "logs",
  "log",
  "tmp",
  "temp",
  "cache",
  ".cache",
  ".trash",
  ".npm",
  ".yarn",
  ".pnpm",
  ".vscode",
  ".idea",
  ".gradle",
  ".m2",
  ".nuget",
  ".cargo",
  ".rustup",
  ".conda",
  "appdata",
  "library",
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata"
]);

let session = null;
let stopping = false;

function normalizeServerUrl(value) {
  const url = new URL(String(value).trim());
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

async function exists(target) {
  try {
    await fs.promises.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueRoots(roots) {
  const seen = new Set();
  return roots.filter((root) => {
    const key = path.resolve(root.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function driveCandidates() {
  if (process.platform !== "win32") return ["/"];
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`);
}

async function buildRoots() {
  const home = os.homedir();
  const candidates = [
    { label: "用户目录", path: home, kind: "home" },
    { label: "桌面", path: path.join(home, "Desktop"), kind: "folder" },
    { label: "下载", path: path.join(home, "Downloads"), kind: "folder" },
    { label: "文档", path: path.join(home, "Documents"), kind: "folder" },
    ...driveCandidates().map((drive) => ({ label: `磁盘 ${drive.replace("\\", "")}`, path: drive, kind: "drive" }))
  ];

  const available = [];
  for (const item of candidates) {
    if (await exists(item.path)) available.push(item);
  }

  return uniqueRoots(available).map((root, index) => ({
    id: `root-${index}`,
    label: root.label,
    kind: root.kind,
    path: path.resolve(root.path)
  }));
}

function isInside(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelPath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.normalize(raw);
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("路径不合法。");
  }
  return normalized;
}

async function resolveRootPath(rootId, relPath = "") {
  const root = session.roots.find((item) => item.id === rootId) || session.roots[0];
  if (!root) throw new Error("没有找到可读取的位置。");

  const normalizedRel = normalizeRelPath(relPath);
  const target = path.resolve(root.path, normalizedRel);
  if (!isInside(target, root.path)) throw new Error("路径超出允许范围。");

  return { root, relPath: normalizedRel, target };
}

function entryPayload(root, relPath, entry, stats) {
  const entryRel = path.join(relPath, entry.name);
  const isDir = stats.isDirectory();
  return {
    name: entry.name,
    relPath: entryRel.replace(/\\/g, "/"),
    rootId: root.id,
    rootLabel: root.label,
    isDir,
    type: isDir ? "folder" : "file",
    size: isDir ? null : stats.size,
    sizeLabel: isDir ? "" : formatBytes(stats.size),
    mtime: stats.mtime.toISOString()
  };
}

async function listDirectory(payload) {
  const { root, target, relPath } = await resolveRootPath(payload.rootId, payload.path || "");
  const stats = await fs.promises.stat(target);
  if (!stats.isDirectory()) throw new Error("目标不是文件夹。");

  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    try {
      const entryStats = await fs.promises.stat(path.join(target, entry.name));
      items.push(entryPayload(root, relPath, entry, entryStats));
    } catch {
      // Skip unreadable or disappearing entries.
    }
  }

  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });

  const parentPath = relPath ? path.dirname(relPath).replace(/\\/g, "/") : "";
  return {
    root,
    path: relPath.replace(/\\/g, "/"),
    parentPath: parentPath === "." ? "" : parentPath,
    items
  };
}

async function searchFiles(payload) {
  const query = String(payload.q || "").trim().toLowerCase();
  if (query.length < 2) throw new Error("搜索关键词至少需要 2 个字符。");

  const limit = Math.min(Number(payload.limit || 80), MAX_SEARCH_RESULTS);
  const { root, target, relPath } = await resolveRootPath(payload.rootId, payload.path || "");
  const results = [];
  const queue = [{ abs: target, rel: relPath }];
  let scannedDirs = 0;
  let truncated = false;

  while (queue.length > 0 && results.length < limit) {
    if (scannedDirs >= MAX_SEARCH_DIRS) {
      truncated = true;
      break;
    }

    const current = queue.shift();
    scannedDirs += 1;

    let entries;
    try {
      entries = await fs.promises.readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      const entryRel = path.join(current.rel, entry.name);
      const entryAbs = path.join(current.abs, entry.name);

      if (lowerName.includes(query)) {
        try {
          const stats = await fs.promises.stat(entryAbs);
          results.push(entryPayload(root, current.rel, entry, stats));
          if (results.length >= limit) break;
        } catch {
          // Ignore unreadable matches.
        }
      }

      if (entry.isDirectory() && !excludedSearchDirs.has(lowerName)) {
        queue.push({ abs: entryAbs, rel: entryRel });
      }
    }
  }

  return {
    query,
    root,
    path: relPath.replace(/\\/g, "/"),
    results,
    scannedDirs,
    truncated: truncated || results.length >= limit
  };
}

async function requestJson(route, payload, timeoutMs = 30000) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const url = new URL(`${SERVER_URL}${route}`);
  const response = await requestBuffer(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length)
    },
    body,
    timeoutMs
  });

  let data = {};
  try {
    data = response.body.length ? JSON.parse(response.body.toString("utf8")) : {};
  } catch {
    data = {};
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const err = new Error(data.error || `服务器返回 ${response.statusCode}`);
    err.statusCode = response.statusCode;
    throw err;
  }
  return data;
}

async function sendResult(requestId, result, error = "") {
  await requestJson("/api/agent/result", {
    agentId: session.agentId,
    token: session.token,
    requestId,
    result,
    error
  });
}

async function uploadFile(requestId, payload) {
  const { target } = await resolveRootPath(payload.rootId, payload.path || "");
  const stats = await fs.promises.stat(target);
  if (!stats.isFile()) throw new Error("只能下载文件。");

  const url = new URL(`${SERVER_URL}/api/agent/upload`);
  url.searchParams.set("requestId", requestId);

  const prepared = await prepareRequest(url, "POST", {
    "x-agent-id": session.agentId,
    "x-agent-token": session.token,
    "x-file-name": encodeURIComponent(path.basename(target)),
    "x-file-size": String(stats.size),
    "content-type": "application/octet-stream",
    "content-length": String(stats.size)
  });

  const readStream = fs.createReadStream(target);
  await new Promise((resolve, reject) => {
    const req = prepared.client.request(prepared.options, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(body || `上传失败：${res.statusCode}`));
          }
        });
      });

    req.on("error", (err) => {
      readStream.destroy();
      reject(err);
    });
    readStream.on("error", (err) => {
      req.destroy();
      reject(err);
    });
    readStream.pipe(req);
  });
}

function getProxyUrl(targetUrl) {
  const isHttps = targetUrl.protocol === "https:";
  const raw =
    (isHttps ? process.env.HTTPS_PROXY || process.env.https_proxy : process.env.HTTP_PROXY || process.env.http_proxy) ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";
  return raw ? new URL(raw) : null;
}

function proxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`;
}

function defaultPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

async function createProxyTunnel(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxyPort = defaultPort(proxyUrl);
    const socket = net.connect(proxyPort, proxyUrl.hostname);
    const targetHost = `${targetUrl.hostname}:${defaultPort(targetUrl)}`;
    const auth = proxyAuthHeader(proxyUrl);
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("代理连接超时。"));
    }, 15000);

    socket.on("connect", () => {
      const lines = [`CONNECT ${targetHost} HTTP/1.1`, `Host: ${targetHost}`];
      if (auth) lines.push(`Proxy-Authorization: ${auth}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;

      clearTimeout(timer);
      const head = buffer.slice(0, marker).toString("utf8");
      const rest = buffer.slice(marker + 4);
      if (!/^HTTP\/\d\.\d 2\d\d/.test(head)) {
        socket.destroy();
        reject(new Error(`代理隧道失败：${head.split("\n")[0] || "unknown"}`));
        return;
      }

      socket.removeAllListeners("data");
      if (rest.length) socket.unshift(rest);
      const secureSocket = tls.connect({
        socket,
        servername: targetUrl.hostname
      });
      secureSocket.once("secureConnect", () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function prepareRequest(url, method, headers = {}) {
  const proxyUrl = getProxyUrl(url);
  const isHttps = url.protocol === "https:";
  const pathWithSearch = `${url.pathname || "/"}${url.search || ""}`;

  if (!proxyUrl) {
    return {
      client: isHttps ? https : http,
      options: {
        method,
        hostname: url.hostname,
        port: defaultPort(url),
        path: pathWithSearch,
        headers
      }
    };
  }

  if (!isHttps) {
    const auth = proxyAuthHeader(proxyUrl);
    return {
      client: http,
      options: {
        method,
        hostname: proxyUrl.hostname,
        port: defaultPort(proxyUrl),
        path: url.href,
        headers: {
          ...headers,
          Host: url.host,
          ...(auth ? { "Proxy-Authorization": auth } : {})
        }
      }
    };
  }

  const tunnel = await createProxyTunnel(url, proxyUrl);
  return {
    client: https,
    options: {
      method,
      hostname: url.hostname,
      port: defaultPort(url),
      path: pathWithSearch,
      headers,
      createConnection: () => tunnel
    }
  };
}

async function requestBuffer(url, { method, headers, body, timeoutMs }) {
  const prepared = await prepareRequest(url, method, headers);
  return new Promise((resolve, reject) => {
    const req = prepared.client.request(prepared.options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });

    const timer = setTimeout(() => {
      req.destroy(new Error("请求服务器超时。"));
    }, timeoutMs);

    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));

    if (body) req.write(body);
    req.end();
  });
}

async function handleCommand(command) {
  if (!command || !command.id || !command.type) return;

  try {
    if (command.type === "list") {
      await sendResult(command.id, await listDirectory(command.payload || {}));
      return;
    }

    if (command.type === "search") {
      await sendResult(command.id, await searchFiles(command.payload || {}));
      return;
    }

    if (command.type === "download") {
      await uploadFile(command.id, command.payload || {});
      return;
    }

    throw new Error(`未知命令：${command.type}`);
  } catch (error) {
    await sendResult(command.id, null, error.message || String(error)).catch(() => {});
  }
}

async function connect() {
  const roots = await buildRoots();
  if (!roots.length) throw new Error("没有找到可读取的位置。");

  const data = await requestJson("/api/agent/connect", {
    host: os.hostname(),
    platform: process.platform,
    roots,
    version: "1.0.0"
  });

  session = {
    agentId: data.agentId,
    token: data.token,
    pairingPin: data.pairingPin,
    roots
  };

  console.log("========================================");
  console.log("  电脑端代理已连接服务器");
  console.log(`  Server: ${SERVER_URL}`);
  console.log(`  Host:   ${os.hostname()}`);
  console.log(`  PIN:    ${data.pairingPin}`);
  console.log("  手机打开服务器域名，输入上面的 PIN 完成配对。");
  console.log("  保持此窗口运行，按 Ctrl+C 可停止代理。");
  console.log("========================================");
}

async function pollLoop() {
  let delay = 1000;
  while (!stopping) {
    try {
      const data = await requestJson(
        "/api/agent/poll",
        {
          agentId: session.agentId,
          token: session.token
        },
        35000
      );
      delay = 1000;
      if (data.command) {
        handleCommand(data.command);
      }
    } catch (error) {
      console.error(`[代理] ${error.message || error}`);
      if (error.statusCode === 401) {
        console.log("检测到认证失效（可能服务器已重启），正在尝试重新连接并获取新 PIN...");
        break;
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000);
    }
  }
}

process.on("SIGINT", () => {
  stopping = true;
  console.log("\n代理已停止。");
  process.exit(0);
});

async function main() {
  while (!stopping) {
    try {
      await connect();
      await pollLoop();
    } catch (error) {
      console.error(`启动或运行中出错：${error.message || error}`);
      await sleep(5000);
    }
  }
}

main().catch((error) => {
  console.error(`未捕获的致命错误：${error.message || error}`);
  process.exit(1);
});
