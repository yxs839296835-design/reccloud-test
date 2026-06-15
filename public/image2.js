const storageKey = "image2-vip-v2-config";

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
let currentDataUrl = "";
let currentDownloadName = "image2-result.png";

function apiEndpoint() {
  const configuredEndpoint = String(window.IMAGE2_API_ENDPOINT || "").trim();
  if (configuredEndpoint) return configuredEndpoint;
  return window.location.protocol === "file:"
    ? "http://localhost:5177/api/image2-generate"
    : "/api/image2-generate";
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
    els.timerLine.textContent = `已等待 ${elapsed} 秒，正在等待当前同步接口返回。`;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
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
      if (key === "originalUrl" && typeof item === "string") {
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
  currentDataUrl = "";
  currentDownloadName = "image2-result.png";
  els.imageStage.innerHTML = "<span>生成成功后，图片会显示在这里</span>";
  els.openImageLink.removeAttribute("href");
  els.downloadImageLink.removeAttribute("href");
  els.openImageLink.classList.add("disabled");
  els.downloadImageLink.classList.add("disabled");
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
  const status = result?.status || response?.status;
  const upstreamError = result?.data?.error || result?.error;
  const message = upstreamError?.message || result?.message || result?.raw || result?.statusText || response?.statusText || "";

  if (String(message).includes("high load")) {
    return ["模型负载较高", "上游返回模型负载高，请稍后重试。这是供应商通道状态，不是页面解析失败。"];
  }
  if (String(message).includes("Concurrency limit exceeded")) {
    return ["账号并发超限", "同一账号同时运行的请求过多，请等前面的任务结束后再试。"];
  }
  if (status === 524) {
    return ["上游网关超时", "上游同步连接已结束。如果后台最终成功，需要供应商提供任务查询接口才能主动取回结果。"];
  }
  if (status === 401 || status === 403) {
    return ["认证失败", "后端内置 Token 无效、过期，或没有该模型权限。"];
  }
  if (status === 400) {
    return ["请求失败 400", message || "上游拒绝了这次请求，请查看完整响应。"];
  }
  return [`请求失败${status ? ` ${status}` : ""}`, message || "接口返回失败，请查看完整响应。"];
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
  setStatus("生成中", "warn");
  setSummary("同步等待中", "请求已发送。本地后端会等待上游返回，并把 URL/base64 统一转成页面可直接显示的 dataURL。", "ok");
  startTimer();
  els.imageStage.innerHTML = "<span>正在生成，请保持页面打开</span>";
  setResponse({ request: { endpoint: apiEndpoint(), ...config, token: "[server-side]" } });

  try {
    const response = await fetch(apiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const raw = await response.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { ok: response.ok, status: response.status, statusText: response.statusText, raw };
    }
    setResponse(result);

    if (!response.ok || !result.ok) {
      const [title, text] = errorSummary(result, response);
      setStatus(`失败 ${result.status || response.status}`, "error");
      setSummary(title, text, "error");
      els.imageStage.innerHTML = "<span>接口返回失败，请查看响应内容</span>";
      return;
    }

    if (!result.image?.dataUrl) {
      setStatus("无图片", "error");
      setSummary(
        "没有拿到可显示图片",
        result.imageError || "接口返回成功，但本地后端没有从响应里提取到 URL/base64 图片数据。",
        "error",
      );
      els.imageStage.innerHTML = "<span>接口返回成功，但没有找到可显示图片</span>";
      return;
    }

    renderImage(result.image.dataUrl, result.image.mimeType, config.output_format);
    setStatus("生成成功", "ok");
    setSummary("生成成功", "图片已由本地后端规范化为 dataURL，页面已直接渲染。", "ok");
  } catch (error) {
    setStatus("请求异常", "error");
    setSummary("请求异常", error.message, "error");
    els.imageStage.innerHTML = "<span>请求异常，请查看响应内容</span>";
    setResponse({ ok: false, error: error.message });
  } finally {
    stopTimer();
    els.generateBtn.disabled = false;
  }
}

loadConfig();
els.form.addEventListener("submit", generateImage);
els.model.addEventListener("change", () => updateSizeOptions());
els.saveConfigBtn.addEventListener("click", saveConfig);
els.clearBtn.addEventListener("click", resetResult);
els.reloadImageBtn.addEventListener("click", reloadImage);
