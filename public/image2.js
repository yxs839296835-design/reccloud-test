const storageKey = "image2-vip-v3-config";
const pollIntervalMs = 10_000;
const maxPollMs = 20 * 60 * 1000;

const els = {
  form: document.querySelector("#imageForm"),
  baseUrl: document.querySelector("#baseUrl"),
  prompt: document.querySelector("#prompt"),
  model: document.querySelector("#model"),
  size: document.querySelector("#size"),
  outputFormat: document.querySelector("#outputFormat"),
  background: document.querySelector("#background"),
  moderation: document.querySelector("#moderation"),
  quality: document.querySelector("#quality"),
  saveConfigBtn: document.querySelector("#saveConfigBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  refreshJobBtn: document.querySelector("#refreshJobBtn"),
  reloadImageBtn: document.querySelector("#reloadImageBtn"),
  openImageLink: document.querySelector("#openImageLink"),
  downloadImageLink: document.querySelector("#downloadImageLink"),
  statusPill: document.querySelector("#statusPill"),
  summaryBox: document.querySelector("#summaryBox"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summaryText: document.querySelector("#summaryText"),
  timerLine: document.querySelector("#timerLine"),
  imageStage: document.querySelector("#imageStage"),
  responseOutput: document.querySelector("#responseOutput"),
};

const sizeOptionsByModel = {
  "gpt-image-2-vip": ["3840x2160", "1536x864", "1536x1024", "1024x1536", "1024x1024", "auto"],
  "gpt-image-2": ["auto", "1024x1024"],
  "gpt-image-1": ["auto", "1024x1024", "1536x1024", "1024x1536"],
};

const sizeLabels = {
  auto: "auto",
  "1024x1024": "1024x1024",
  "1536x1024": "1536x1024",
  "1024x1536": "1024x1536",
  "1536x864": "1536x864",
  "3840x2160": "3840x2160 (4K)",
};

let timer = null;
let pollTimer = null;
let pollStartedAt = 0;
let currentDataUrl = "";
let currentDownloadName = "image2-result.png";
let currentJobId = "";
let currentStatusUrl = "";

function apiEndpoint() {
  const configuredEndpoint = String(window.IMAGE2_API_ENDPOINT || "").trim();
  if (configuredEndpoint) return configuredEndpoint;
  return window.location.protocol === "file:"
    ? "http://localhost:5177/api/image2-generate"
    : "/api/image2-generate";
}

function statusEndpoint(jobId, statusUrl = "") {
  if (statusUrl) return new URL(statusUrl, window.location.href).toString();
  const url = new URL(apiEndpoint(), window.location.href);
  url.searchParams.set("jobId", jobId);
  return url.toString();
}

function setStatus(text, state = "") {
  els.statusPill.textContent = text;
  els.statusPill.className = `status${state ? ` ${state}` : ""}`;
}

function setSummary(title, text, state = "") {
  els.summaryBox.hidden = false;
  els.summaryBox.className = `summary${state ? ` ${state}` : ""}`;
  els.summaryTitle.textContent = title;
  els.summaryText.textContent = text;
}

function clearSummary() {
  els.summaryBox.hidden = true;
  els.summaryTitle.textContent = "";
  els.summaryText.textContent = "";
  els.timerLine.hidden = true;
  els.timerLine.textContent = "";
  els.summaryBox.className = "summary";
}

function startTimer() {
  const startedAt = Date.now();
  els.timerLine.hidden = false;
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    els.timerLine.textContent = `已等待 ${elapsed} 秒，页面正在查询后台任务结果。`;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function maskLargeValues(value) {
  if (Array.isArray(value)) return value.map(maskLargeValues);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (typeof item === "string" && (lower.includes("base64") || lower.includes("b64") || item.startsWith("data:image/"))) {
        return [key, `[image data omitted, ${item.length} chars]`];
      }
      if ((key === "originalUrl" || key === "url") && typeof item === "string") {
        return [key, item.slice(0, 220) + (item.length > 220 ? "..." : "")];
      }
      return [key, maskLargeValues(item)];
    }),
  );
}

function setResponse(payload) {
  els.responseOutput.textContent = JSON.stringify(maskLargeValues(payload), null, 2);
}

function configFromForm() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    prompt: els.prompt.value.trim(),
    model: els.model.value,
    size: els.size.value,
    output_format: els.outputFormat.value,
    background: els.background.value,
    moderation: els.moderation.value,
    quality: els.quality.value,
  };
}

function saveConfig() {
  localStorage.setItem(storageKey, JSON.stringify(configFromForm()));
  setStatus("配置已保存", "ok");
}

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    localStorage.removeItem(storageKey);
  }

  if (saved.baseUrl) els.baseUrl.value = saved.baseUrl;
  if (saved.prompt) els.prompt.value = saved.prompt;
  if (saved.model) els.model.value = saved.model;
  if (saved.output_format) els.outputFormat.value = saved.output_format;
  if (saved.background) els.background.value = saved.background;
  if (saved.moderation) els.moderation.value = saved.moderation;
  if (saved.quality) els.quality.value = saved.quality;
  updateSizeOptions(saved.size);
}

function updateSizeOptions(preferredSize) {
  const sizes = sizeOptionsByModel[els.model.value] || sizeOptionsByModel["gpt-image-2-vip"];
  const previous = preferredSize || els.size.value;
  els.size.replaceChildren(
    ...sizes.map((size) => {
      const option = document.createElement("option");
      option.value = size;
      option.textContent = sizeLabels[size] || size;
      return option;
    }),
  );
  els.size.value = sizes.includes(previous) ? previous : sizes[0];
}

function resetResult() {
  stopPolling();
  stopTimer();
  currentDataUrl = "";
  currentDownloadName = "image2-result.png";
  currentJobId = "";
  currentStatusUrl = "";
  els.imageStage.innerHTML = "<span>生成成功后，图片会显示在这里</span>";
  els.openImageLink.removeAttribute("href");
  els.downloadImageLink.removeAttribute("href");
  els.openImageLink.classList.add("disabled");
  els.downloadImageLink.classList.add("disabled");
  els.refreshJobBtn.disabled = true;
  els.reloadImageBtn.disabled = true;
  setResponse({});
  clearSummary();
  setStatus("等待输入");
}

function extensionFromMime(mimeType, fallback) {
  if (mimeType?.includes("jpeg")) return "jpg";
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("png")) return "png";
  return fallback === "jpeg" ? "jpg" : fallback || "png";
}

function renderImage(dataUrl, mimeType, outputFormat) {
  const image = new Image();
  image.alt = "Image2 generated result";
  image.onload = () => {
    currentDataUrl = dataUrl;
    const ext = extensionFromMime(mimeType, outputFormat);
    currentDownloadName = `image2-result-${Date.now()}.${ext}`;
    els.imageStage.replaceChildren(image);
    els.openImageLink.href = dataUrl;
    els.downloadImageLink.href = dataUrl;
    els.downloadImageLink.download = currentDownloadName;
    els.openImageLink.classList.remove("disabled");
    els.downloadImageLink.classList.remove("disabled");
    els.reloadImageBtn.disabled = false;
  };
  image.onerror = () => {
    els.imageStage.innerHTML = "<span>图片数据已返回，但浏览器无法解码。请查看接口响应。</span>";
  };
  image.src = dataUrl;
}

function reloadImage() {
  if (!currentDataUrl) {
    setSummary("暂无图片", "当前页面没有可重新载入的图片。", "warn");
    return;
  }
  renderImage(currentDataUrl, "", els.outputFormat.value);
  setStatus("已重载", "ok");
  setSummary("已重新载入", "已使用当前 dataURL 重新渲染图片，没有重新请求上游，也不会重复扣费。", "ok");
}

function errorSummary(result, response) {
  const status = result?.statusCode || result?.status || response?.status;
  const upstreamError = result?.data?.error || result?.error;
  const message = upstreamError?.message || result?.message || result?.raw || result?.statusText || response?.statusText || "";

  if (String(message).includes("high load")) {
    return ["模型负载较高", "上游返回模型负载高，请稍后重试。这是供应商通道状态，不是页面解析失败。"];
  }
  if (String(message).includes("Concurrency limit exceeded")) {
    return ["账号并发超限", "同一账号同时运行的请求过多，请等前面的任务结束后再试。"];
  }
  if (status === 524) {
    return ["Cloudflare 到上游超时", "后台任务已经跑起来，但 Cloudflare 调用上游约 126 秒后仍会收到 524。4K 长任务需要切到 Render/Railway/VPS 这类非 Cloudflare Node 后端。"];
  }
  if (status === 401 || status === 403) {
    return ["认证失败", "后端内置 Token 无效、过期，或没有该模型权限。"];
  }
  if (status === 400) {
    return ["请求失败 400", message || "上游拒绝了这次请求，请查看完整响应。"];
  }
  return [`请求失败${status ? ` ${status}` : ""}`, message || "接口返回失败，请查看完整响应。"];
}

function completeWithImage(result) {
  renderImage(result.image.dataUrl, result.image.mimeType, els.outputFormat.value);
  setStatus("生成成功", "ok");
  setSummary("生成成功", "图片已经转换为页面可直接显示的 dataURL。", "ok");
  stopPolling();
  stopTimer();
  els.refreshJobBtn.disabled = !currentJobId;
}

function failWithResult(result, response) {
  const [title, text] = errorSummary(result, response);
  setStatus(`失败 ${result.statusCode || result.status || response?.status || ""}`.trim(), "error");
  setSummary(title, text, "error");
  els.imageStage.innerHTML = "<span>接口返回失败，请查看响应内容</span>";
  stopPolling();
  stopTimer();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { ok: response.ok, status: response.status, statusText: response.statusText, raw };
  }
  return { response, result };
}

async function refreshJobStatus(manual = false) {
  if (!currentJobId) {
    setSummary("暂无任务", "当前没有可刷新的后台任务。", "warn");
    return;
  }

  try {
    const { response, result } = await fetchJson(statusEndpoint(currentJobId, currentStatusUrl));
    setResponse(result);

    if (!response.ok || result.status === "failed" || result.status === "not_found" || result.ok === false) {
      failWithResult(result, response);
      return;
    }

    if (result.image?.dataUrl) {
      completeWithImage(result);
      return;
    }

    const statusText = result.status === "processing" ? "后台生成中" : "任务排队中";
    setStatus(statusText, "warn");
    setSummary(
      statusText,
      manual ? "已主动查询一次，任务还没有返回图片；页面会继续自动刷新。" : "任务还没有返回图片，页面会每 10 秒自动查询一次。",
      "warn",
    );

    if (Date.now() - pollStartedAt > maxPollMs) {
      stopPolling();
      setSummary("自动刷新已暂停", "已经自动查询 20 分钟。你可以点击“刷新任务状态”继续手动查询。", "warn");
    }
  } catch (error) {
    setStatus("查询异常", "error");
    setSummary("查询异常", error.message, "error");
    setResponse({ ok: false, error: error.message, jobId: currentJobId });
  }
}

function handleQueuedResult(result) {
  currentJobId = result.jobId;
  currentStatusUrl = result.statusUrl || "";
  pollStartedAt = Date.now();
  els.refreshJobBtn.disabled = false;
  els.imageStage.innerHTML = "<span>任务已提交，后台正在生成，请保持页面打开</span>";
  setStatus("任务已提交", "warn");
  setSummary("后台生成中", "任务已经进入队列。页面会每 10 秒查询一次，也可以点击“刷新任务状态”主动查询。", "ok");
  setResponse(result);
  stopPolling();
  pollTimer = setInterval(() => refreshJobStatus(false), pollIntervalMs);
  setTimeout(() => refreshJobStatus(false), 1500);
}

async function generateImage(event) {
  event.preventDefault();
  const config = configFromForm();
  if (!config.prompt) {
    setStatus("缺少提示词", "error");
    setSummary("缺少提示词", "请输入要生成的图片描述。", "error");
    els.prompt.focus();
    return;
  }

  resetResult();
  els.generateBtn.disabled = true;
  setStatus("提交中", "warn");
  setSummary("正在提交任务", "请求正在发送。Cloudflare 上会进入后台队列，本地 Node 模式会直接等待同步结果。", "ok");
  startTimer();
  els.imageStage.innerHTML = "<span>正在提交任务</span>";
  setResponse({ request: { endpoint: apiEndpoint(), ...config, token: "[server-side]" } });

  try {
    const { response, result } = await fetchJson(apiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    setResponse(result);

    if (!response.ok && !result.queued) {
      failWithResult(result, response);
      return;
    }

    if (result.queued || (result.jobId && !result.image?.dataUrl)) {
      handleQueuedResult(result);
      return;
    }

    if (!result.ok) {
      failWithResult(result, response);
      return;
    }

    if (!result.image?.dataUrl) {
      setStatus("无图片", "error");
      setSummary(
        "没有拿到可显示图片",
        result.imageError || "接口返回成功，但后端没有从响应里提取到 URL/base64 图片数据。",
        "error",
      );
      els.imageStage.innerHTML = "<span>接口返回成功，但没有找到可显示的图片</span>";
      stopTimer();
      return;
    }

    completeWithImage(result);
  } catch (error) {
    setStatus("请求异常", "error");
    setSummary("请求异常", error.message, "error");
    els.imageStage.innerHTML = "<span>请求异常，请查看响应内容</span>";
    setResponse({ ok: false, error: error.message });
    stopTimer();
  } finally {
    els.generateBtn.disabled = false;
  }
}

loadConfig();
els.form.addEventListener("submit", generateImage);
els.model.addEventListener("change", () => updateSizeOptions());
els.saveConfigBtn.addEventListener("click", saveConfig);
els.clearBtn.addEventListener("click", resetResult);
els.refreshJobBtn.addEventListener("click", () => refreshJobStatus(true));
els.reloadImageBtn.addEventListener("click", reloadImage);
