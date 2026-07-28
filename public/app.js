const els = {
  hostView: document.querySelector("#hostView"),
  hostPin: document.querySelector("#hostPin"),
  phoneUrls: document.querySelector("#phoneUrls"),
  authView: document.querySelector("#authView"),
  mainView: document.querySelector("#mainView"),
  loginForm: document.querySelector("#loginForm"),
  pinInput: document.querySelector("#pinInput"),
  authError: document.querySelector("#authError"),
  hostLine: document.querySelector("#hostLine"),
  refreshBtn: document.querySelector("#refreshBtn"),
  rootSelect: document.querySelector("#rootSelect"),
  searchInput: document.querySelector("#searchInput"),
  clearSearchBtn: document.querySelector("#clearSearchBtn"),
  upBtn: document.querySelector("#upBtn"),
  crumbs: document.querySelector("#crumbs"),
  summaryText: document.querySelector("#summaryText"),
  statusText: document.querySelector("#statusText"),
  fileList: document.querySelector("#fileList"),
  downloadProgress: document.querySelector("#downloadProgress"),
  progressFileName: document.querySelector("#progressFileName"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBarFill: document.querySelector("#progressBarFill"),
  progressBytes: document.querySelector("#progressBytes"),
  cancelDownloadBtn: document.querySelector("#cancelDownloadBtn")
};

const state = {
  pin: localStorage.getItem("remote-files-pin") || "",
  host: "",
  roots: [],
  rootId: localStorage.getItem("remote-files-root") || "",
  currentPath: localStorage.getItem("remote-files-path") || "",
  mode: "browse",
  searchTimer: null,
  activeController: null,
  loading: false,
  resumeNeeded: false,
  downloadPollTimer: null,
  downloadCanceled: false,
  statusTimer: null
};

const params = new URLSearchParams(location.search);
const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const forceMobile = params.has("mobile");
const forceHost = params.has("host");

function setStatus(text, tone = "") {
  els.statusText.textContent = text;
  els.statusText.dataset.tone = tone;
}

function setLoading(isLoading, text = "") {
  state.loading = isLoading;
  els.refreshBtn.textContent = isLoading ? "X" : "R";
  els.refreshBtn.title = isLoading ? "取消并刷新" : "刷新";
  if (text) setStatus(text, isLoading ? "active" : "");
}

function showOnly(view) {
  els.hostView.classList.toggle("hidden", view !== "host");
  els.authView.classList.toggle("hidden", view !== "auth");
  els.mainView.classList.toggle("hidden", view !== "main");
}

function showAuth(message = "") {
  showOnly("auth");
  els.authError.textContent = message;
  els.pinInput.value = state.pin;
  setTimeout(() => els.pinInput.focus(), 50);
}

function showMain() {
  showOnly("main");
  startStatusHeartbeat();
}

function resetSession(message = "PIN 已重置，请重新输入电脑端显示的新 PIN。") {
  clearTimeout(state.searchTimer);
  clearDownloadPoll();
  stopStatusHeartbeat();
  abortActiveRequest();

  state.pin = "";
  state.host = "";
  state.roots = [];
  state.rootId = "";
  state.currentPath = "";
  state.mode = "browse";
  state.loading = false;
  state.resumeNeeded = false;
  state.downloadCanceled = true;

  localStorage.removeItem("remote-files-pin");
  localStorage.removeItem("remote-files-root");
  localStorage.removeItem("remote-files-path");

  els.searchInput.value = "";
  els.rootSelect.innerHTML = "";
  els.crumbs.innerHTML = "";
  els.fileList.innerHTML = "";
  els.summaryText.textContent = "0 项";
  els.pinInput.value = "";
  els.downloadProgress.classList.add("hidden");
  setLoading(false);
  showAuth(message);
}

function startStatusHeartbeat() {
  stopStatusHeartbeat();
  state.statusTimer = setInterval(async () => {
    if (els.mainView.classList.contains("hidden") || !state.pin) return;
    try {
      await api("/api/status");
    } catch (error) {
      if (isAuthExpiredError(error)) return;
    }
  }, 15000);
}

function stopStatusHeartbeat() {
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

function makeAuthExpiredError(message) {
  const error = new Error(message || "PIN 已失效。");
  error.authExpired = true;
  return error;
}

function isAuthExpiredError(error) {
  return Boolean(error && error.authExpired);
}

function normalizeSize(value) {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function abortActiveRequest() {
  if (state.activeController) {
    state.activeController.abort();
    state.activeController = null;
  }
}

function makeController(timeoutMs = 30000) {
  abortActiveRequest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  state.activeController = controller;
  return controller;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-access-pin": state.pin,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      const message = data.error || "PIN 已重置，请重新输入电脑端显示的新 PIN。";
      resetSession(message);
      throw makeAuthExpiredError(message);
    }
    throw new Error(data.error || "请求失败");
  }
  return data;
}

async function loadPairingInfo() {
  showOnly("host");
  try {
    const data = await api("/api/pairing");
    els.hostPin.textContent = data.pin;
    els.phoneUrls.innerHTML = "";

    const urls = data.phoneUrls?.length ? data.phoneUrls : data.addresses?.map((item) => item.url) || [];
    if (!urls.length) {
      const empty = document.createElement("p");
      empty.textContent = "未检测到局域网地址。";
      els.phoneUrls.append(empty);
      return;
    }

    for (const url of urls) {
      const row = document.createElement("a");
      row.href = url;
      row.textContent = url;
      els.phoneUrls.append(row);
    }
  } catch (error) {
    els.hostPin.textContent = "------";
    els.phoneUrls.innerHTML = "";
    const message = document.createElement("p");
    message.textContent = error.message;
    els.phoneUrls.append(message);
  }
}

async function login(pin) {
  setStatus("正在连接", "active");
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "连接失败");
  }

  state.pin = data.pin;
  state.host = data.host;
  state.roots = data.roots || [];
  localStorage.setItem("remote-files-pin", state.pin);
  hydrateMain();
}

function hydrateMain() {
  if (!state.roots.length) {
    showAuth("主机没有可读取的位置。");
    return;
  }

  if (!state.roots.some((root) => root.id === state.rootId)) {
    state.rootId = state.roots[0].id;
    state.currentPath = "";
  }

  renderRoots();
  els.hostLine.textContent = state.host ? `已连接 ${state.host}` : "已连接电脑";
  showMain();
  loadCurrentDirectory();
}

function renderRoots() {
  els.rootSelect.innerHTML = "";
  for (const root of state.roots) {
    const option = document.createElement("option");
    option.value = root.id;
    option.textContent = root.label;
    els.rootSelect.append(option);
  }
  els.rootSelect.value = state.rootId;
}

function currentRoot() {
  return state.roots.find((root) => root.id === state.rootId) || state.roots[0];
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, value);
    }
  }
  return search.toString();
}

async function loadCurrentDirectory() {
  state.mode = "browse";
  clearTimeout(state.searchTimer);
  els.searchInput.value = "";
  setLoading(true, "正在读取");
  const controller = makeController(25000);

  try {
    const data = await api(`/api/list?${queryString({ rootId: state.rootId, path: state.currentPath })}`, {
      signal: controller.signal
    });
    state.currentPath = data.path || "";
    localStorage.setItem("remote-files-root", state.rootId);
    localStorage.setItem("remote-files-path", state.currentPath);
    renderCrumbs();
    renderItems(data.items || []);
    setStatus("已就绪");
  } catch (error) {
    if (isAuthExpiredError(error)) return;
    if (error.name === "AbortError") {
      if (document.visibilityState === "hidden") {
        state.resumeNeeded = true;
        setStatus("返回后自动刷新", "active");
      } else {
        setStatus("已取消", "error");
      }
      return;
    }
    setStatus(error.message, "error");
    renderEmpty("无法读取当前位置");
  } finally {
    if (state.activeController === controller) {
      state.activeController = null;
      setLoading(false);
    }
  }
}

function renderCrumbs() {
  els.crumbs.innerHTML = "";
  const root = currentRoot();
  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.textContent = root?.label || "当前位置";
  rootBtn.addEventListener("click", () => {
    state.currentPath = "";
    loadCurrentDirectory();
  });
  els.crumbs.append(rootBtn);

  const parts = state.currentPath ? state.currentPath.split("/") : [];
  let built = "";
  for (const part of parts) {
    built = built ? `${built}/${part}` : part;
    const targetPath = built;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = part;
    button.addEventListener("click", () => {
      state.currentPath = targetPath;
      loadCurrentDirectory();
    });
    els.crumbs.append(button);
  }

  els.upBtn.disabled = !state.currentPath;
}

function renderItems(items) {
  els.fileList.innerHTML = "";
  els.summaryText.textContent = `${items.length} 项`;

  if (!items.length) {
    renderEmpty(state.mode === "search" ? "没有匹配结果" : "文件夹为空");
    return;
  }

  for (const item of items) {
    els.fileList.append(createItem(item));
  }
}

function createItem(item) {
  const row = document.createElement("article");
  row.className = "file-item";

  const badge = item.isDir ? document.createElement("button") : document.createElement("a");
  badge.className = `file-badge ${item.isDir ? "folder" : "file"}`;
  badge.title = item.isDir ? "打开文件夹" : "下载文件";
  badge.textContent = item.isDir ? "D" : "F";

  const meta = item.isDir ? document.createElement("button") : document.createElement("a");
  meta.className = "file-meta";

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = item.name;

  const sub = document.createElement("span");
  sub.className = "file-sub";
  sub.textContent = item.isDir ? `${item.rootLabel} / ${item.relPath}` : `${item.sizeLabel} - ${formatDate(item.mtime)}`;
  meta.append(name, sub);

  const action = item.isDir ? document.createElement("button") : document.createElement("a");
  action.className = "row-action";
  action.title = item.isDir ? "打开" : "下载";
  action.textContent = item.isDir ? ">" : "v";

  if (item.isDir) {
    for (const element of [badge, meta, action]) {
      element.type = "button";
      element.addEventListener("click", () => openDirectory(item));
    }
  } else {
    for (const element of [badge, meta, action]) {
      element.href = downloadUrl(item);
      element.rel = "noopener";
      element.download = item.name;
      element.addEventListener("click", (event) => {
        event.preventDefault();
        startDownload(item);
      });
    }
  }

  row.append(badge, meta, action);
  return row;
}

function openDirectory(item) {
  state.rootId = item.rootId;
  state.currentPath = item.relPath;
  loadCurrentDirectory();
}

function downloadUrl(item) {
  return `/api/download?${queryString({
    rootId: item.rootId,
    path: item.relPath,
    pin: state.pin
  })}`;
}

function prepareDownloadUrl(item) {
  return `/api/prepare-download?${queryString({
    rootId: item.rootId,
    path: item.relPath,
    name: item.name || "",
    size: Number.isFinite(Number(item.size)) ? String(Number(item.size)) : "",
    pin: state.pin
  })}`;
}

async function startDownload(item) {
  state.downloadCanceled = false;
  clearDownloadPoll();
  showDownloadProgress(item.name, 0, normalizeSize(item.size), "正在建立连接");
  setStatus(`正在准备下载：${item.name}`, "active");

  try {
    const data = await api(prepareDownloadUrl(item), {
      headers: { "x-access-pin": state.pin }
    });
    if (data.ready && data.downloadUrl) {
      const readySize = normalizeSize(data.size ?? item.size);
      updateDownloadProgress(100, readySize, readySize, "准备完成");
      triggerPreparedDownload(data.downloadUrl, data.name || item.name);
      return;
    }
    if (!data.jobId) throw new Error("下载任务创建失败");
    pollDownloadStatus(data.jobId, item.name);
  } catch (error) {
    if (isAuthExpiredError(error)) return;
    hideDownloadProgress();
    setStatus(error.message || "下载准备失败", "error");
  }
}

function showDownloadProgress(name, received = 0, size = null, text = "正在准备") {
  els.progressFileName.textContent = name || "下载文件";
  els.downloadProgress.classList.remove("hidden");
  updateDownloadProgress(0, received, size, text);
}

function hideDownloadProgress() {
  els.downloadProgress.classList.add("hidden");
  clearDownloadPoll();
}

function clearDownloadPoll() {
  if (state.downloadPollTimer) {
    clearTimeout(state.downloadPollTimer);
    state.downloadPollTimer = null;
  }
}

function updateDownloadProgress(percent, received, size, text = "") {
  const cleanPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const cleanReceived = Math.max(0, Number(received) || 0);
  const cleanSize = normalizeSize(size);
  els.progressPercent.textContent = `${cleanPercent}%`;
  els.progressBarFill.style.width = `${cleanPercent}%`;
  if (cleanSize !== null) {
    els.progressBytes.textContent = `${formatBytes(cleanReceived)} / ${formatBytes(cleanSize)}${text ? ` - ${text}` : ""}`;
  } else if (cleanReceived > 0) {
    els.progressBytes.textContent = `${formatBytes(cleanReceived)}${text ? ` - ${text}` : ""}`;
  } else {
    els.progressBytes.textContent = text || "正在等待电脑端上传";
  }
}

async function pollDownloadStatus(jobId, fallbackName) {
  if (state.downloadCanceled) return;

  try {
    const data = await api(`/api/prepare-download/status?${queryString({ jobId })}`, {
      headers: { "x-access-pin": state.pin }
    });

    const percent = data.percent || 0;
    const name = data.name || fallbackName;
    els.progressFileName.textContent = name;
    updateDownloadProgress(percent, data.received || 0, normalizeSize(data.size), data.message || (data.status === "queued" ? "等待电脑端响应" : "电脑端正在上传"));

    if (data.status === "ready" && data.downloadUrl) {
      const readySize = normalizeSize(data.size ?? data.received);
      updateDownloadProgress(100, readySize ?? data.received ?? 0, readySize, "准备完成");
      triggerPreparedDownload(data.downloadUrl, name);
      return;
    }

    if (data.status === "error") {
      throw new Error(data.error || "下载准备失败");
    }

    state.downloadPollTimer = setTimeout(() => pollDownloadStatus(jobId, fallbackName), 700);
  } catch (error) {
    if (isAuthExpiredError(error)) return;
    hideDownloadProgress();
    setStatus(error.message || "下载准备失败", "error");
  }
}

function triggerPreparedDownload(downloadUrl, name) {
  clearDownloadPoll();
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = name || "download";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();

  setStatus("上传完成，已弹出浏览器下载", "active");
  setTimeout(() => {
    hideDownloadProgress();
    setStatus("已就绪");
  }, 1200);
}

function renderEmpty(text) {
  els.fileList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  els.fileList.append(empty);
  els.summaryText.textContent = "0 项";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function runSearch() {
  const q = els.searchInput.value.trim();
  if (q.length === 0) {
    loadCurrentDirectory();
    return;
  }

  if (q.length < 2) {
    setStatus("至少输入 2 个字符", "error");
    return;
  }

  state.mode = "search";
  setLoading(true, "正在搜索");
  renderCrumbs();
  const controller = makeController(30000);

  try {
    const data = await api(`/api/search?${queryString({
      rootId: state.rootId,
      path: state.currentPath,
      q,
      limit: 40
    })}`, { signal: controller.signal });
    renderItems(data.results || []);
    setStatus(data.truncated ? "已显示前 40 项，可缩小关键词继续搜" : "搜索完成");
  } catch (error) {
    if (isAuthExpiredError(error)) return;
    if (error.name === "AbortError") {
      if (document.visibilityState === "hidden") {
        state.resumeNeeded = true;
        setStatus("返回后自动刷新", "active");
      } else {
        setStatus("已取消", "error");
      }
      return;
    }
    setStatus(error.message, "error");
    renderEmpty("搜索失败");
  } finally {
    if (state.activeController === controller) {
      state.activeController = null;
      setLoading(false);
    }
  }
}

function scheduleSearch() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(runSearch, 450);
}

function refreshNow() {
  clearTimeout(state.searchTimer);
  state.resumeNeeded = false;
  if (state.loading) {
    abortActiveRequest();
    setStatus("正在刷新", "active");
    setTimeout(() => {
      if (els.searchInput.value.trim()) {
        runSearch();
      } else {
        loadCurrentDirectory();
      }
    }, 150);
    return;
  }

  if (els.searchInput.value.trim()) {
    runSearch();
  } else {
    loadCurrentDirectory();
  }
}

function resumeMainView() {
  if (els.mainView.classList.contains("hidden")) return;
  clearTimeout(state.searchTimer);
  state.resumeNeeded = false;
  abortActiveRequest();
  setStatus("正在恢复", "active");
  setTimeout(() => {
    if (els.searchInput.value.trim()) {
      runSearch();
    } else {
      loadCurrentDirectory();
    }
  }, 50);
}

function shouldResumeAfterReturn(event) {
  if (els.mainView.classList.contains("hidden")) return false;
  if (event?.persisted) return true;
  if (state.resumeNeeded) return true;
  if (state.loading) return true;
  return els.statusText.textContent === "已取消" && els.summaryText.textContent === "0 项";
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = els.pinInput.value.trim();
  if (!pin) {
    showAuth("请输入配对 PIN。");
    return;
  }

  try {
    await login(pin);
  } catch (error) {
    resetSession(error.message);
  }
});

els.rootSelect.addEventListener("change", () => {
  state.rootId = els.rootSelect.value;
  state.currentPath = "";
  loadCurrentDirectory();
});

els.refreshBtn.addEventListener("click", refreshNow);
els.searchInput.addEventListener("input", scheduleSearch);

els.cancelDownloadBtn.addEventListener("click", () => {
  state.downloadCanceled = true;
  hideDownloadProgress();
  setStatus("已取消下载等待", "error");
});

els.clearSearchBtn.addEventListener("click", () => {
  els.searchInput.value = "";
  loadCurrentDirectory();
});

els.upBtn.addEventListener("click", () => {
  if (!state.currentPath) return;
  const parts = state.currentPath.split("/");
  parts.pop();
  state.currentPath = parts.join("/");
  loadCurrentDirectory();
});

window.addEventListener("pageshow", (event) => {
  if (shouldResumeAfterReturn(event)) {
    resumeMainView();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldResumeAfterReturn()) {
    resumeMainView();
  }
});

if ((isLocalHost && !forceMobile) || forceHost) {
  loadPairingInfo();
} else if (state.pin) {
  login(state.pin).catch(() => resetSession("请重新输入配对 PIN。"));
} else {
  showAuth();
}
