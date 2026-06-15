import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 5177);
const image2TimeoutMs = Number(process.env.IMAGE2_TIMEOUT_MS || 1800000);
const image2DefaultToken = process.env.IMAGE2_API_TOKEN || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders,
  });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`JSON 解析失败: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function normalizeBaseUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("API 基础地址必须以 http:// 或 https:// 开头");
  }
  return value.endsWith("/open/v1") ? value : `${value}/open/v1`;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const relativePath = url.pathname === "/" ? "index.html" : safePath.replace(/^[/\\]/, "");
  const filePath = join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, ...corsHeaders });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders });
    res.end("Not found");
  }
}

function buildHeaders({ token, tokenMode }) {
  const headers = { "Content-Type": "application/json" };
  const value = String(token || "").trim();
  if (!value) return headers;

  if (tokenMode === "access_token_header") headers.AccessToken = value;
  else if (tokenMode === "authorization_bearer") headers.Authorization = `Bearer ${value}`;
  else if (tokenMode === "authorization_raw") headers.Authorization = value;
  else headers.access_token = value;

  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJsonWithLongTimeout(target, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(body || {});
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(bodyText),
        },
      },
      (upstream) => {
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => {
          resolve({
            ok: upstream.statusCode >= 200 && upstream.statusCode < 300,
            status: upstream.statusCode,
            statusText: upstream.statusMessage || "",
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Local image2 proxy timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    });
    req.on("error", reject);
    req.write(bodyText);
    req.end();
  });
}

function looksLikeBase64Image(value) {
  if (typeof value !== "string") return false;
  const raw = value.startsWith("data:") ? value.split(",").pop() : value;
  return raw.length > 2000 && /^[A-Za-z0-9+/=\r\n]+$/.test(raw);
}

function extractImagePayload(value, seen = new Set()) {
  if (!value) return null;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return { type: "url", value };
    if (value.startsWith("data:image/") || looksLikeBase64Image(value)) return { type: "base64", value };
    return null;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);

  const urlKeys = ["url", "image_url", "imageUrl", "download_url", "downloadUrl"];
  for (const key of urlKeys) {
    if (typeof value[key] === "string" && value[key]) return { type: "url", value: value[key] };
  }

  const base64Keys = ["b64_json", "base64", "image_base64", "imageBase64", "b64", "data"];
  for (const key of base64Keys) {
    if (looksLikeBase64Image(value[key])) return { type: "base64", value: value[key] };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImagePayload(item, seen);
      if (found) return found;
    }
    return null;
  }

  for (const item of Object.values(value)) {
    const found = extractImagePayload(item, seen);
    if (found) return found;
  }
  return null;
}

function downloadBinaryWithLongTimeout(rawUrl, timeoutMs, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Image download redirected too many times."));
      return;
    }

    const target = new URL(rawUrl);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "User-Agent": "image2-local-tester/1.0",
        },
      },
      (upstream) => {
        if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
          upstream.resume();
          const nextUrl = new URL(upstream.headers.location, target).toString();
          downloadBinaryWithLongTimeout(nextUrl, timeoutMs, redirectCount + 1).then(resolve, reject);
          return;
        }

        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            reject(new Error(`Image download failed with HTTP ${upstream.statusCode}: ${buffer.toString("utf8", 0, 300)}`));
            return;
          }
          resolve({
            buffer,
            contentType: upstream.headers["content-type"] || "image/png",
            status: upstream.statusCode,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Image download timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function normalizeImageResult(data, outputFormat) {
  const image = extractImagePayload(data);
  if (!image) return null;

  const fallbackMimeType = outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat || "png"}`;
  if (image.type === "base64") {
    const value = String(image.value || "");
    if (value.startsWith("data:image/")) {
      return {
        type: "base64",
        dataUrl: value,
        mimeType: value.slice(5, value.indexOf(";")) || fallbackMimeType,
        source: "base64",
      };
    }
    return {
      type: "base64",
      dataUrl: `data:${fallbackMimeType};base64,${value.replace(/\s/g, "")}`,
      mimeType: fallbackMimeType,
      source: "base64",
    };
  }

  const downloaded = await downloadBinaryWithLongTimeout(image.value, image2TimeoutMs);
  return {
    type: "url",
    originalUrl: image.value,
    dataUrl: `data:${downloaded.contentType};base64,${downloaded.buffer.toString("base64")}`,
    mimeType: downloaded.contentType,
    bytes: downloaded.buffer.length,
    source: "downloaded-url",
  };
}

function normalizeImageApiBaseUrl(raw) {
  const value = String(raw || "https://api.5spiritual.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("Image API base URL must start with http:// or https://");
  }
  return value;
}

async function callOpenApi({ baseUrl, path, method = "GET", query = {}, body, token, tokenMode }) {
  const root = normalizeBaseUrl(baseUrl);
  const target = new URL(`${root}${path.startsWith("/") ? path : `/${path}`}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    target.searchParams.set(key, value);
  });

  const upstream = await fetch(target, {
    method,
    headers: buildHeaders({ token, tokenMode }),
    body: method.toUpperCase() === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const text = await upstream.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep raw text when the upstream is not JSON.
  }

  return {
    ok: upstream.ok,
    status: upstream.status,
    statusText: upstream.statusText,
    url: target.toString(),
    data: parsed,
  };
}

async function proxy(req, res) {
  let payload;
  try {
    payload = await collectBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const upstreamStartedAt = Date.now();
  try {
    const result = await callOpenApi(payload);

    sendJson(res, 200, {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      elapsedMs: Date.now() - upstreamStartedAt,
      url: result.url,
      data: result.data,
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message,
    });
  }
}

async function generateImage2(req, res) {
  let payload;
  try {
    payload = await collectBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  const prompt = String(payload.prompt || "").trim();
  const token = String(payload.token || image2DefaultToken || "").trim();
  if (!prompt) {
    sendJson(res, 400, { ok: false, error: "Please enter a prompt." });
    return;
  }
  if (!token) {
    sendJson(res, 400, { ok: false, error: "Please enter a Bearer token." });
    return;
  }

  const startedAt = Date.now();
  try {
    const root = normalizeImageApiBaseUrl(payload.baseUrl);
    const target = new URL("/v1/images/generations", root);
    const body = {
      model: payload.model || "gpt-image-2-vip",
      prompt,
      n: 1,
      size: payload.size || "1024x1024",
      background: payload.background || "opaque",
      moderation: payload.moderation || "auto",
      quality: payload.quality || "auto",
      output_format: payload.output_format || "png",
    };

    const upstream = await postJsonWithLongTimeout(
      target,
      {
        Authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      image2TimeoutMs,
    );
    const text = upstream.text;
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Keep raw text when the upstream is not JSON.
    }

    let image = null;
    let imageError = null;
    if (upstream.ok) {
      try {
        image = await normalizeImageResult(data, body.output_format);
      } catch (error) {
        imageError = error.message;
      }
    }

    sendJson(res, 200, {
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      elapsedMs: Date.now() - startedAt,
      request: {
        url: target.toString(),
        body,
      },
      data,
      image,
      imageError,
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message,
      errorName: error.name,
      errorCode: error.code,
      errorCause: error.cause?.message,
    });
  }
}

async function waitForFileReady({ baseUrl, token, tokenMode, fileId }) {
  let lastDetail = null;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const detail = await callOpenApi({
      baseUrl,
      path: "/common/file_detail",
      method: "GET",
      query: { id: fileId },
      token,
      tokenMode,
    });
    lastDetail = detail.data?.data || detail.data;
    if (lastDetail?.status === 1) return lastDetail;
    await sleep(3000);
  }
  return lastDetail;
}

async function uploadAudio(req, res) {
  let payload;
  try {
    payload = await collectBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const { baseUrl, token, tokenMode, file, service = "make_video_audio" } = payload;
  if (!token) {
    sendJson(res, 400, { error: "请先获取 access_token" });
    return;
  }
  if (!file?.name || !file?.dataBase64) {
    sendJson(res, 400, { error: "请先选择音频文件" });
    return;
  }

  try {
    const buffer = Buffer.from(file.dataBase64, "base64");
    const uploadInfoResp = await callOpenApi({
      baseUrl,
      path: "/common/create_upload_url",
      method: "GET",
      query: { service, name: file.name },
      token,
      tokenMode,
    });
    const uploadInfo = uploadInfoResp.data?.data;
    if (!uploadInfoResp.ok || uploadInfoResp.data?.code !== 0 || !uploadInfo?.sign_url) {
      sendJson(res, 200, {
        ok: false,
        step: "create_upload_url",
        response: uploadInfoResp,
      });
      return;
    }

    const putResp = await fetch(uploadInfo.sign_url, {
      method: "PUT",
      headers: {
        "Content-Type": uploadInfo.mime_type || file.type || "application/octet-stream",
      },
      body: buffer,
    });
    if (!putResp.ok) {
      sendJson(res, 200, {
        ok: false,
        step: "upload_to_oss",
        status: putResp.status,
        statusText: putResp.statusText,
      });
      return;
    }

    const detail = await waitForFileReady({
      baseUrl,
      token,
      tokenMode,
      fileId: uploadInfo.file_id,
    });

    sendJson(res, 200, {
      ok: true,
      file_id: uploadInfo.file_id,
      full_path: uploadInfo.full_path,
      mime_type: uploadInfo.mime_type,
      detail,
      ready: detail?.status === 1,
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if (req.url === "/api/proxy" && req.method === "POST") {
    await proxy(req, res);
    return;
  }
  if (req.url === "/api/upload-audio" && req.method === "POST") {
    await uploadAudio(req, res);
    return;
  }
  if (req.url === "/api/upload-file" && req.method === "POST") {
    await uploadAudio(req, res);
    return;
  }
  if (req.url === "/api/image2-generate" && req.method === "POST") {
    await generateImage2(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.requestTimeout = image2TimeoutMs + 60000;
server.timeout = image2TimeoutMs + 60000;

server.listen(port, () => {
  console.log(`Chanjing tester is running at http://localhost:${port}`);
});
