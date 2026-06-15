const DEFAULT_TIMEOUT_MS = 1_800_000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function normalizeBaseUrl(raw) {
  const value = String(raw || "https://api.5spiritual.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("Image API base URL must start with http:// or https://");
  }
  return value;
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

  for (const key of ["url", "image_url", "imageUrl", "download_url", "downloadUrl"]) {
    if (typeof value[key] === "string" && value[key]) return { type: "url", value: value[key] };
  }

  for (const key of ["b64_json", "base64", "image_base64", "imageBase64", "b64", "data"]) {
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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
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

  const response = await fetch(image.value, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "image2-cloudflare-tester/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || fallbackMimeType;
  const buffer = await response.arrayBuffer();
  return {
    type: "url",
    originalUrl: image.value,
    dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
    mimeType: contentType,
    bytes: buffer.byteLength,
    source: "downloaded-url",
  };
}

export function onRequestOptions() {
  return json({}, 204);
}

export async function onRequestPost({ request, env }) {
  const startedAt = Date.now();
  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, error: `JSON parse failed: ${error.message}` }, 400);
  }

  const prompt = String(payload.prompt || "").trim();
  const token = String(payload.token || env.IMAGE2_API_TOKEN || "").trim();
  if (!prompt) return json({ ok: false, error: "Please enter a prompt." }, 400);
  if (!token) return json({ ok: false, error: "IMAGE2_API_TOKEN is not configured." }, 500);

  const root = normalizeBaseUrl(payload.baseUrl);
  const target = new URL("/v1/images/generations", root);
  const body = {
    model: payload.model || "gpt-image-2-vip",
    prompt,
    n: 1,
    size: payload.size || "3840x2160",
    background: payload.background || "opaque",
    moderation: payload.moderation || "auto",
    quality: payload.quality || "high",
    output_format: payload.output_format || "png",
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), DEFAULT_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers: {
          Authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await upstream.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Keep raw text.
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

    return json({
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
    return json(
      {
        ok: false,
        error: error.message,
        errorName: error.name,
        elapsedMs: Date.now() - startedAt,
      },
      502,
    );
  }
}
