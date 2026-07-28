const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 5423);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DIRS = 2500;
const LOCAL_ACCESS_PIN = String(crypto.randomInt(100000, 999999));
const LOG_FILE = path.join(__dirname, "server.log");
const AGENT_POLL_TIMEOUT_MS = 25000;
const COMMAND_TIMEOUT_MS = 90000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const AGENT_STALE_MS = 10 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip"
};

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

const agents = new Map();
const pinToAgentId = new Map();
const downloadTokens = new Map();
const downloadPrepareJobs = new Map();
const kickedAgentIds = new Map();

function logError(error) {
  const message = error instanceof Error ? `${error.stack || error.message}` : String(error);
  fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, () => {});
}

process.on("uncaughtException", logError);
process.on("unhandledRejection", logError);

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const rawBody = await readBody(req);
  return rawBody ? JSON.parse(rawBody) : {};
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function generatePairingPin(preferredPin = "") {
  const cleanPreferred = String(preferredPin || "").trim();
  if (/^\d{6}$/.test(cleanPreferred) && cleanPreferred !== LOCAL_ACCESS_PIN && !pinToAgentId.has(cleanPreferred)) {
    return cleanPreferred;
  }

  let pin;
  do {
    pin = String(crypto.randomInt(100000, 999999));
  } while (pin === LOCAL_ACCESS_PIN || pinToAgentId.has(pin));
  return pin;
}

function isInside(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeStaticPath(requestedPath) {
  const urlPath = decodeURIComponent(requestedPath.split("?")[0]);
  const normalized = urlPath === "/" ? "/index.html" : urlPath;
  const target = path.resolve(PUBLIC_DIR, `.${normalized}`);
  return isInside(target, PUBLIC_DIR) ? target : null;
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

function parseFileSize(value) {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function attachmentDisposition(name) {
  const cleanName = path.basename(String(name || "download.bin"));
  const asciiName = cleanName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download.bin";
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`;
}

function downloadCacheDir() {
  return path.join(__dirname, "download_cache");
}

function ensureDownloadCacheDir() {
  const dir = downloadCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function downloadCacheKey(agent, rootId, relPath) {
  return crypto.createHash("sha256").update(`${agent.id}:${rootId || ""}:${relPath || ""}`).digest("hex");
}

function registerDownloadToken(meta) {
  const token = randomId("dl");
  downloadTokens.set(token, {
    ...meta,
    expiresAt: Date.now() + 30 * 60 * 1000
  });
  return token;
}

function getValidCachedDownload(agent, rootId, relPath) {
  const cacheDir = downloadCacheDir();
  const cacheKey = downloadCacheKey(agent, rootId, relPath);
  const cachePath = path.join(cacheDir, cacheKey);
  const cacheMetaPath = `${cachePath}.json`;
  if (!fs.existsSync(cachePath) || !fs.existsSync(cacheMetaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
    if (Date.now() - Number(meta.timestamp || 0) > 30 * 60 * 1000) return null;
    const stats = fs.statSync(cachePath);
    return {
      cacheKey,
      cachePath,
      cacheMetaPath,
      name: meta.name || "download.bin",
      contentType: meta.contentType || "application/octet-stream",
      size: stats.size
    };
  } catch (error) {
    logError(error);
    return null;
  }
}

function streamCachedDownload(res, meta) {
  const stats = fs.statSync(meta.cachePath);
  res.writeHead(200, {
    "content-type": meta.contentType || "application/octet-stream",
    "content-disposition": attachmentDisposition(meta.name),
    "cache-control": "no-store",
    "content-length": stats.size
  });
  const stream = fs.createReadStream(meta.cachePath);
  stream.on("error", (err) => {
    logError(err);
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
  res.on("close", () => stream.destroy());
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

async function buildLocalRoots() {
  const home = os.homedir();
  const candidates = [
    { label: "项目目录", path: __dirname, kind: "workspace" },
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

let localRootsPromise = buildLocalRoots();

async function getLocalRoots() {
  return localRootsPromise;
}

async function resolveLocalRootPath(rootId, relPath = "") {
  const roots = await getLocalRoots();
  const root = roots.find((item) => item.id === rootId) || roots[0];
  if (!root) throw new Error("没有找到可读取的位置。");

  const normalizedRel = normalizeRelPath(relPath);
  const target = path.resolve(root.path, normalizedRel);
  if (!isInside(target, root.path)) throw new Error("路径超出允许范围。");

  return { root, relPath: normalizedRel, target };
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, nets] of Object.entries(interfaces)) {
    for (const address of nets || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      const virtual = /vmware|virtualbox|hyper-v|vethernet|loopback|tap|wsl|docker|npcap/i.test(name);
      addresses.push({
        interface: name,
        address: address.address,
        virtual,
        url: `http://${address.address}:${PORT}`
      });
    }
  }
  return addresses.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  return String(forwardedFor || realIp || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function isLocalRequest(req) {
  const ip = getClientIp(req);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
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

async function listLocalDirectory(url) {
  const rootId = url.searchParams.get("rootId");
  const relPath = url.searchParams.get("path") || "";
  const { root, target, relPath: normalizedRel } = await resolveLocalRootPath(rootId, relPath);
  const stats = await fs.promises.stat(target);
  if (!stats.isDirectory()) throw new Error("目标不是文件夹。");

  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    try {
      const entryStats = await fs.promises.stat(path.join(target, entry.name));
      items.push(entryPayload(root, normalizedRel, entry, entryStats));
    } catch {
      // Skip unreadable or disappearing entries.
    }
  }

  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });

  const parentPath = normalizedRel ? path.dirname(normalizedRel).replace(/\\/g, "/") : "";
  return {
    root,
    path: normalizedRel.replace(/\\/g, "/"),
    parentPath: parentPath === "." ? "" : parentPath,
    items
  };
}

async function searchLocalFiles(url) {
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  if (query.length < 2) throw new Error("搜索关键词至少需要 2 个字符。");

  const rootId = url.searchParams.get("rootId");
  const relPath = url.searchParams.get("path") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || 80), MAX_SEARCH_RESULTS);
  const { root, target, relPath: normalizedRel } = await resolveLocalRootPath(rootId, relPath);
  const results = [];
  const queue = [{ abs: target, rel: normalizedRel }];
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
    path: normalizedRel.replace(/\\/g, "/"),
    results,
    scannedDirs,
    truncated: truncated || results.length >= limit
  };
}

async function pipeLocalDownload(res, url) {
  const rootId = url.searchParams.get("rootId");
  const relPath = url.searchParams.get("path") || "";
  const { target } = await resolveLocalRootPath(rootId, relPath);
  const stats = await fs.promises.stat(target);
  if (!stats.isFile()) throw new Error("只能下载文件。");

  const name = path.basename(target);
  const ext = path.extname(name).toLowerCase();
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "content-length": stats.size,
    "content-disposition": attachmentDisposition(name),
    "cache-control": "no-store"
  });
  const stream = fs.createReadStream(target);
  stream.pipe(res);
  res.on("close", () => stream.destroy());
}

function touchAgent(agent) {
  agent.lastSeen = Date.now();
}

function publicAgent(agent) {
  return {
    id: agent.id,
    host: agent.host,
    platform: agent.platform,
    connectedAt: new Date(agent.connectedAt).toISOString(),
    lastSeen: new Date(agent.lastSeen).toISOString(),
    roots: agent.roots
  };
}

function getAgentByCredentials(agentId, token) {
  const agent = agents.get(String(agentId || ""));
  if (!agent || agent.token !== String(token || "")) return null;
  touchAgent(agent);
  return agent;
}

function checkAgentKicked(res, agentId) {
  const idStr = String(agentId || "");
  if (kickedAgentIds.has(idStr)) {
    sendJson(res, 409, { error: "当前设备已有新的代理连接，本实例已停用。" });
    return true;
  }
  return false;
}

function sendCommandToWaitingAgent(agent, command) {
  if (!agent.pollRes || agent.pollRes.writableEnded) return false;
  clearTimeout(agent.pollTimer);
  const res = agent.pollRes;
  agent.pollRes = null;
  agent.pollTimer = null;
  sendJson(res, 200, { command });
  return true;
}

function dispatchCommand(agent, command) {
  if (!sendCommandToWaitingAgent(agent, command)) {
    agent.queue.push(command);
  }
}

function enqueueAgentCommand(agent, type, payload, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const requestId = randomId("req");
    const timeout = setTimeout(() => {
      agent.pending.delete(requestId);
      reject(new Error("电脑端代理响应超时。"));
    }, timeoutMs);

    agent.pending.set(requestId, { type, resolve, reject, timeout });
    dispatchCommand(agent, { id: requestId, type, payload });
  });
}

function getContextFromPin(pin) {
  const cleanPin = String(pin || "");
  const agentId = pinToAgentId.get(cleanPin);
  if (agentId) {
    const agent = agents.get(agentId);
    if (agent) return { mode: "agent", agent };
  }

  if (cleanPin === LOCAL_ACCESS_PIN) {
    return { mode: "local" };
  }

  return null;
}

function requireContext(req, res, url) {
  const pin = req.headers["x-access-pin"] || url.searchParams.get("pin");
  const context = getContextFromPin(pin);
  if (!context) {
    sendJson(res, 401, { error: "请输入正确的配对 PIN。" });
    return null;
  }
  if (context.agent) touchAgent(context.agent);
  return context;
}

async function handleAgentConnect(req, res) {
  const payload = await readJson(req);
  const clientId = String(payload.clientId || "").trim();

  if (clientId) {
    for (const [oldId, oldAgent] of agents.entries()) {
      if (oldAgent.clientId !== clientId) continue;

      kickedAgentIds.set(oldId, Date.now());
      pinToAgentId.delete(oldAgent.pairingPin);
      agents.delete(oldId);
      if (oldAgent.pollRes && !oldAgent.pollRes.writableEnded) {
        clearTimeout(oldAgent.pollTimer);
        sendJson(oldAgent.pollRes, 409, { error: "当前设备已有新的代理连接，本实例已停用。" });
      }
      for (const pending of oldAgent.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject?.(new Error("电脑端代理已重连。"));
        if (pending.phoneRes && !pending.phoneRes.writableEnded) {
          sendJson(pending.phoneRes, 502, { error: "电脑端代理已重连，请刷新页面重新连接。" });
        }
      }
    }
  }

  const id = randomId("agent");
  const token = randomId("token");
  const pairingPin = generatePairingPin(payload.pairingPin);
  const now = Date.now();

  const agent = {
    id,
    token,
    pairingPin,
    clientId,
    host: String(payload.host || "电脑主机"),
    platform: String(payload.platform || ""),
    roots: Array.isArray(payload.roots) ? payload.roots : [],
    connectedAt: now,
    lastSeen: now,
    queue: [],
    pending: new Map(),
    pollRes: null,
    pollTimer: null
  };

  agents.set(id, agent);
  pinToAgentId.set(pairingPin, id);

  sendJson(res, 200, {
    agentId: id,
    token,
    pairingPin,
    host: agent.host,
    serverTime: new Date().toISOString()
  });
}

async function handleAgentPoll(req, res) {
  const payload = await readJson(req);
  if (checkAgentKicked(res, payload.agentId)) return;
  const agent = getAgentByCredentials(payload.agentId, payload.token);
  if (!agent) {
    sendJson(res, 401, { error: "代理认证失败。" });
    return;
  }

  if (agent.queue.length > 0) {
    sendJson(res, 200, { command: agent.queue.shift() });
    return;
  }

  if (agent.pollRes && !agent.pollRes.writableEnded) {
    sendJson(agent.pollRes, 200, { command: null });
    clearTimeout(agent.pollTimer);
  }

  agent.pollRes = res;
  agent.pollTimer = setTimeout(() => {
    if (agent.pollRes === res) {
      agent.pollRes = null;
      agent.pollTimer = null;
      sendJson(res, 200, { command: null });
    }
  }, AGENT_POLL_TIMEOUT_MS);

  req.on("close", () => {
    if (agent.pollRes === res && res.writableEnded) {
      agent.pollRes = null;
      clearTimeout(agent.pollTimer);
      agent.pollTimer = null;
    }
  });
}

async function handleAgentResult(req, res) {
  const payload = await readJson(req);
  if (checkAgentKicked(res, payload.agentId)) return;
  const agent = getAgentByCredentials(payload.agentId, payload.token);
  if (!agent) {
    sendJson(res, 401, { error: "代理认证失败。" });
    return;
  }

  const pending = agent.pending.get(String(payload.requestId || ""));
  if (!pending) {
    sendJson(res, 404, { error: "请求已过期或不存在。" });
    return;
  }

  if (!payload.error && pending.type === "prepare-download" && payload.result?.prepareMeta) {
    const job = pending.jobId ? downloadPrepareJobs.get(pending.jobId) : null;
    if (job) {
      job.status = "uploading";
      job.name = String(payload.result.name || job.name || "download.bin");
      job.size = parseFileSize(payload.result.size) ?? job.size;
      job.received = Math.max(0, Number(job.received) || 0);
      job.updatedAt = Date.now();
      job.lastProgressAt = Date.now();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (payload.error) {
    agent.pending.delete(payload.requestId);
    clearTimeout(pending.timeout);
    pending.reject(new Error(String(payload.error)));
  } else if (pending.type !== "download") {
    agent.pending.delete(payload.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(payload.result);
  }

  sendJson(res, 200, { ok: true });
}

function handleAgentUpload(req, res, url) {
  if (checkAgentKicked(res, req.headers["x-agent-id"])) {
    req.resume();
    return;
  }
  const agent = getAgentByCredentials(req.headers["x-agent-id"], req.headers["x-agent-token"]);
  if (!agent) {
    sendJson(res, 401, { error: "代理认证失败。" });
    req.resume();
    return;
  }

  const requestId = String(url.searchParams.get("requestId") || "");
  const pending = agent.pending.get(requestId);
  if (!pending || (pending.type !== "download" && pending.type !== "prepare-download")) {
    sendJson(res, 404, { error: "下载请求已过期或不存在。" });
    req.resume();
    return;
  }

  agent.pending.delete(requestId);
  clearTimeout(pending.timeout);

  const rawName = String(req.headers["x-file-name"] || "download.bin");
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch (e) {
    // Fallback if not encoded or invalid URL encoding
  }
  const size = String(req.headers["x-file-size"] || "");
  const parsedSize = parseFileSize(size);
  const contentType = String(req.headers["content-type"] || "application/octet-stream");

  if (pending.type === "prepare-download") {
    const job = pending.jobId ? downloadPrepareJobs.get(pending.jobId) : null;
    if (job) {
      job.status = "uploading";
      job.name = name;
      job.contentType = contentType;
      job.size = parsedSize;
      job.received = 0;
      job.updatedAt = Date.now();
      job.lastProgressAt = Date.now();
    }

    ensureDownloadCacheDir();
    const cachePath = pending.cachePath;
    const cacheMetaPath = pending.cacheMetaPath;
    const tempPath = `${cachePath}.${requestId}.tmp`;
    const writeStream = fs.createWriteStream(tempPath);
    let finished = false;

    const fail = (error) => {
      if (finished) return;
      finished = true;
      logError(error);
      writeStream.destroy();
      fs.unlink(tempPath, () => {});
      if (job) {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = Date.now();
      }
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      if (!res.writableEnded) sendJson(res, 500, { error: "服务器缓存下载文件失败。" });
    };

    writeStream.on("error", fail);
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("代理上传已中断。")));
    req.on("data", (chunk) => {
      if (job) {
        job.received += chunk.length;
        job.updatedAt = Date.now();
        job.lastProgressAt = Date.now();
      }
    });

    writeStream.on("finish", () => {
      if (finished) return;
      finished = true;
      try {
        fs.renameSync(tempPath, cachePath);
        fs.writeFileSync(cacheMetaPath, JSON.stringify({
          name,
          contentType,
          size,
          timestamp: Date.now()
        }));
        const token = registerDownloadToken({
          cachePath,
          cacheMetaPath,
          name,
          contentType,
          size
        });
        if (job) {
        job.status = "ready";
          job.received = job.size ?? job.received;
          job.downloadUrl = `/api/cached-download?token=${encodeURIComponent(token)}`;
          job.updatedAt = Date.now();
        }
        pending.resolve({
          name,
          size: parsedSize,
          downloadUrl: `/api/cached-download?token=${encodeURIComponent(token)}`
        });
        if (!res.writableEnded) sendJson(res, 200, { ok: true });
      } catch (error) {
        fail(error);
      }
    });

    req.pipe(writeStream);
    return;
  }

  const phoneRes = pending.phoneRes;
  if (!phoneRes) {
    sendJson(res, 404, { error: "下载请求已过期或不存在。" });
    req.resume();
    return;
  }

  if (!phoneRes.writableEnded) {
    const headers = {
      "content-type": contentType,
      "content-disposition": attachmentDisposition(name),
      "cache-control": "no-store"
    };
    if (size && /^\d+$/.test(size)) headers["content-length"] = size;
    phoneRes.writeHead(200, headers);

    let cacheStream = null;
    let cachePath = "";
    let cacheMetaPath = "";
    const isCacheable = size && /^\d+$/.test(size) && Number(size) <= 25 * 1024 * 1024;

    if (isCacheable) {
      const cacheDir = path.join(__dirname, "download_cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const cacheKey = crypto.createHash("md5").update(`${agent.id}:${pending.rootId}:${pending.path}`).digest("hex");
      cachePath = path.join(cacheDir, cacheKey);
      cacheMetaPath = cachePath + ".json";

      cacheStream = fs.createWriteStream(cachePath);
      cacheStream.on("error", (err) => {
        logError(err);
        cacheStream = null;
      });

      cacheStream.on("finish", () => {
        try {
          fs.writeFileSync(cacheMetaPath, JSON.stringify({
            name,
            contentType,
            size,
            timestamp: Date.now()
          }));
        } catch (e) {
          logError(e);
        }
      });
    }

    req.pipe(phoneRes);
    if (cacheStream) req.pipe(cacheStream);

    const cleanUp = () => {
      if (!phoneRes.writableEnded) {
        req.destroy();
        if (cacheStream) {
          cacheStream.destroy();
          setTimeout(() => {
            fs.unlink(cachePath, () => {});
            fs.unlink(cacheMetaPath, () => {});
          }, 100);
        }
      }
    };
    phoneRes.on("close", cleanUp);
    phoneRes.on("error", cleanUp);

    req.on("close", () => {
      phoneRes.off("close", cleanUp);
      phoneRes.off("error", cleanUp);
    });
  } else {
    req.resume();
  }

  req.on("end", () => sendJson(res, 200, { ok: true }));
  req.on("error", (error) => {
    logError(error);
    if (!phoneRes.writableEnded) phoneRes.end();
  });
}

async function handleSession(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "请求内容格式不正确。" });
    return;
  }

  const context = getContextFromPin(payload.pin);
  if (!context) {
    sendJson(res, 401, { error: "配对 PIN 不正确，或电脑端代理未连接。" });
    return;
  }

  if (context.mode === "agent") {
    sendJson(res, 200, {
      ok: true,
      pin: context.agent.pairingPin,
      host: context.agent.host,
      platform: context.agent.platform,
      roots: context.agent.roots,
      remote: true,
      agent: publicAgent(context.agent)
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    pin: LOCAL_ACCESS_PIN,
    host: os.hostname(),
    platform: os.platform(),
    roots: await getLocalRoots(),
    remote: false,
    addresses: getLanAddresses()
  });
}

async function handlePairingInfo(req, res) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: "配对码只允许在本机页面查看。公网模式请运行电脑端代理查看 PIN。" });
    return;
  }

  sendJson(res, 200, {
    pin: LOCAL_ACCESS_PIN,
    host: os.hostname(),
    port: PORT,
    localUrl: `http://127.0.0.1:${PORT}`,
    phoneUrls: getLanAddresses().filter((item) => !item.virtual).map((item) => item.url),
    addresses: getLanAddresses()
  });
}

async function handleList(req, res, url, context) {
  if (context.mode === "agent") {
    const result = await enqueueAgentCommand(context.agent, "list", {
      rootId: url.searchParams.get("rootId"),
      path: url.searchParams.get("path") || ""
    });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 200, await listLocalDirectory(url));
}

async function handleSearch(req, res, url, context) {
  if (context.mode === "agent") {
    const result = await enqueueAgentCommand(context.agent, "search", {
      rootId: url.searchParams.get("rootId"),
      path: url.searchParams.get("path") || "",
      q: url.searchParams.get("q") || "",
      limit: Math.min(Number(url.searchParams.get("limit") || 80), MAX_SEARCH_RESULTS)
    });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 200, await searchLocalFiles(url));
}

async function handleDownload(req, res, url, context) {
  if (context.mode === "local") {
    await pipeLocalDownload(res, url);
    return;
  }

  const agent = context.agent;
  if (!agent) {
    sendJson(res, 400, { error: "代理不可用。" });
    return;
  }

  // Check if valid cache exists on server first to avoid duplicate agent download
  const cacheDir = path.join(__dirname, "download_cache");
  const cacheKey = crypto.createHash("md5").update(`${agent.id}:${url.searchParams.get("rootId")}:${url.searchParams.get("path") || ""}`).digest("hex");
  const cachePath = path.join(cacheDir, cacheKey);
  const cacheMetaPath = cachePath + ".json";

  if (fs.existsSync(cachePath) && fs.existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
      // Verify cache is not too old (within 10 minutes)
      if (Date.now() - meta.timestamp < 10 * 60 * 1000) {
        const stats = fs.statSync(cachePath);
        const headers = {
          "content-type": meta.contentType || "application/octet-stream",
          "content-disposition": attachmentDisposition(meta.name),
          "cache-control": "no-store",
          "content-length": stats.size
        };
        res.writeHead(200, headers);
        const stream = fs.createReadStream(cachePath);
        stream.on("error", (err) => {
          logError(err);
          if (!res.writableEnded) res.end();
        });
        stream.pipe(res);
        res.on("close", () => stream.destroy());
        return;
      }
    } catch (e) {
      logError(e);
    }
  }

  const requestId = randomId("download");
  const timeout = setTimeout(() => {
    agent.pending.delete(requestId);
    if (!res.writableEnded) sendJson(res, 504, { error: "等待电脑端上传文件超时。" });
  }, DOWNLOAD_TIMEOUT_MS);

  agent.pending.set(requestId, {
    type: "download",
    phoneRes: res,
    timeout,
    rootId: url.searchParams.get("rootId"),
    path: url.searchParams.get("path") || "",
    resolve: () => {},
    reject: (error) => {
      if (!res.writableEnded) sendJson(res, 500, { error: error.message || "下载失败。" });
    }
  });

  res.on("close", () => {
    if (res.writableEnded) return;
    agent.pending.delete(requestId);
    clearTimeout(timeout);
  });

  dispatchCommand(agent, {
    id: requestId,
    type: "download",
    payload: {
      rootId: url.searchParams.get("rootId"),
      path: url.searchParams.get("path") || ""
    }
  });
}

async function handlePrepareDownload(req, res, url, context) {
  if (context.mode === "local") {
    sendJson(res, 200, {
      ok: true,
      ready: true,
      downloadUrl: `/api/download?${new URLSearchParams({
        rootId: url.searchParams.get("rootId") || "",
        path: url.searchParams.get("path") || "",
        pin: url.searchParams.get("pin") || req.headers["x-access-pin"] || ""
      }).toString()}`
    });
    return;
  }

  const agent = context.agent;
  const rootId = url.searchParams.get("rootId");
  const relPath = url.searchParams.get("path") || "";
  const requestedName = String(url.searchParams.get("name") || "").trim();
  const requestedSize = parseFileSize(url.searchParams.get("size"));
  const cached = getValidCachedDownload(agent, rootId, relPath);
  if (cached) {
    const token = registerDownloadToken(cached);
    sendJson(res, 200, {
      ok: true,
      ready: true,
      name: cached.name,
      size: cached.size,
      downloadUrl: `/api/cached-download?token=${encodeURIComponent(token)}`
    });
    return;
  }

  ensureDownloadCacheDir();
  const cacheKey = downloadCacheKey(agent, rootId, relPath);
  const cachePath = path.join(downloadCacheDir(), cacheKey);
  const cacheMetaPath = `${cachePath}.json`;
  const requestId = randomId("download");
  const jobId = randomId("prep");
  const job = {
    id: jobId,
    agentId: agent.id,
    status: "queued",
    name: requestedName || path.basename(relPath || "download.bin"),
    received: 0,
    size: requestedSize,
    error: "",
    downloadUrl: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastProgressAt: Date.now(),
    expiresAt: Date.now() + DOWNLOAD_TIMEOUT_MS + 5 * 60 * 1000
  };
  downloadPrepareJobs.set(jobId, job);

  const timeout = setTimeout(() => {
    agent.pending.delete(requestId);
    job.status = "error";
    job.error = "等待电脑端准备文件超时。";
    job.updatedAt = Date.now();
  }, DOWNLOAD_TIMEOUT_MS);

  agent.pending.set(requestId, {
    type: "prepare-download",
    timeout,
    jobId,
    rootId,
    path: relPath,
    cachePath,
    cacheMetaPath,
    resolve: () => {
      agent.pending.delete(requestId);
      clearTimeout(timeout);
    },
    reject: (error) => {
      agent.pending.delete(requestId);
      clearTimeout(timeout);
      job.status = "error";
      job.error = error.message || "下载准备失败。";
      job.updatedAt = Date.now();
    }
  });

  dispatchCommand(agent, {
    id: requestId,
    type: "download",
    payload: {
      rootId,
      path: relPath
    }
  });

  sendJson(res, 200, {
    ok: true,
    ready: false,
    jobId,
    name: job.name,
    received: 0,
    size: job.size
  });
}

function handlePrepareDownloadStatus(req, res, url, context) {
  const jobId = String(url.searchParams.get("jobId") || "");
  const job = downloadPrepareJobs.get(jobId);
  if (!job || Date.now() > job.expiresAt) {
    downloadPrepareJobs.delete(jobId);
    sendJson(res, 404, { error: "下载任务不存在或已过期。" });
    return;
  }

  if (context.mode === "agent" && job.agentId !== context.agent.id) {
    sendJson(res, 403, { error: "无权查看此下载任务。" });
    return;
  }

  const now = Date.now();
  if (job.status === "queued" && now - job.createdAt > 60000) {
    job.status = "error";
    job.error = "电脑端代理没有开始上传，请检查代理是否在线后重试。";
    job.updatedAt = now;
  } else if (job.status === "uploading" && now - (job.lastProgressAt || job.updatedAt) > 90000) {
    job.status = "error";
    job.error = "电脑端上传长时间没有进度，请重新点击下载。";
    job.updatedAt = now;
  }

  const percent = job.size ? Math.min(100, Math.floor((job.received / job.size) * 100)) : 0;
  sendJson(res, 200, {
    ok: true,
    jobId: job.id,
    status: job.status,
    name: job.name,
    received: job.received,
    size: job.size,
    percent: job.status === "ready" ? 100 : percent,
    message: job.status === "queued" ? "等待电脑端响应" : "",
    error: job.error,
    downloadUrl: job.status === "ready" ? job.downloadUrl : ""
  });
}

function handleCachedDownload(req, res, url) {
  const token = String(url.searchParams.get("token") || "");
  const meta = downloadTokens.get(token);
  if (!meta || Date.now() > meta.expiresAt) {
    downloadTokens.delete(token);
    sendJson(res, 404, { error: "下载链接已过期，请重新点击下载。" });
    return;
  }

  try {
    streamCachedDownload(res, meta);
  } catch (error) {
    logError(error);
    sendJson(res, 404, { error: "下载文件不存在，请重新点击下载。" });
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/agent/connect") {
      await handleAgentConnect(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/poll") {
      await handleAgentPoll(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/result") {
      await handleAgentResult(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/upload") {
      handleAgentUpload(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pairing") {
      await handlePairingInfo(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      await handleSession(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cached-download") {
      handleCachedDownload(req, res, url);
      return;
    }

    const context = requireContext(req, res, url);
    if (!context) return;

    if (req.method === "GET" && url.pathname === "/api/status") {
      if (context.mode === "agent") {
        sendJson(res, 200, {
          host: context.agent.host,
          platform: context.agent.platform,
          roots: context.agent.roots,
          remote: true,
          agent: publicAgent(context.agent)
        });
      } else {
        sendJson(res, 200, {
          host: os.hostname(),
          platform: os.platform(),
          uptime: Math.round(process.uptime()),
          roots: await getLocalRoots(),
          remote: false,
          addresses: getLanAddresses()
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      await handleList(req, res, url, context);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      await handleSearch(req, res, url, context);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prepare-download/status") {
      handlePrepareDownloadStatus(req, res, url, context);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prepare-download") {
      await handlePrepareDownload(req, res, url, context);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/download") {
      await handleDownload(req, res, url, context);
      return;
    }

    sendJson(res, 404, { error: "API 不存在。" });
  } catch (error) {
    logError(error);
    sendJson(res, 500, { error: error.message || "服务器内部错误。" });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const filePath = safeStaticPath(req.url || "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, meta] of downloadTokens.entries()) {
    if (now > meta.expiresAt) downloadTokens.delete(token);
  }
  for (const [jobId, job] of downloadPrepareJobs.entries()) {
    if (now > job.expiresAt) downloadPrepareJobs.delete(jobId);
  }
  for (const [id, time] of kickedAgentIds.entries()) {
    if (now - time > 60000) kickedAgentIds.delete(id);
  }

  for (const [id, agent] of agents.entries()) {
    if (now - agent.lastSeen < AGENT_STALE_MS) continue;

    pinToAgentId.delete(agent.pairingPin);
    agents.delete(id);

    if (agent.pollRes && !agent.pollRes.writableEnded) {
      clearTimeout(agent.pollTimer);
      sendJson(agent.pollRes, 200, { command: null });
    }

    for (const pending of agent.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject?.(new Error("电脑端代理已断开。"));
      if (pending.phoneRes && !pending.phoneRes.writableEnded) {
        sendJson(pending.phoneRes, 502, { error: "电脑端代理已断开。" });
      }
    }
  }
}, 30000);

function cleanDownloadCache() {
  const cacheDir = path.join(__dirname, "download_cache");
  if (!fs.existsSync(cacheDir)) return;
  fs.readdir(cacheDir, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const file of files) {
      if (file.endsWith(".json")) continue;
      const filePath = path.join(cacheDir, file);
      const metaPath = filePath + ".json";
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 30 * 60 * 1000) {
          fs.unlink(filePath, () => {});
          fs.unlink(metaPath, () => {});
        }
      });
    }
  });
}

// Clean on start and every 5 minutes
cleanDownloadCache();
setInterval(cleanDownloadCache, 5 * 60 * 1000);

server.listen(PORT, "0.0.0.0", async () => {
  const lanAddresses = getLanAddresses();
  const roots = await getLocalRoots();
  console.log("========================================");
  console.log("  手机文件遥控服务已启动");
  console.log(`  Local: http://127.0.0.1:${PORT}`);
  for (const item of lanAddresses) {
    const label = item.virtual ? "Virtual" : "LAN";
    console.log(`  ${label}: ${item.url} (${item.interface})`);
  }
  console.log(`  Local PIN: ${LOCAL_ACCESS_PIN}`);
  console.log("  电脑公网代理模式：请运行 agent/pc-agent.js 连接此服务器。");
  console.log("  本机可访问位置:");
  for (const root of roots) {
    console.log(`  - ${root.label}: ${root.path}`);
  }
  console.log("========================================");
});
