const JOB_TTL_SECONDS = 60 * 60 * 24;

function jobKey(jobId) {
  return `image2:${jobId}`;
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

function maskLargeValues(value) {
  if (Array.isArray(value)) return value.map(maskLargeValues);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (typeof item === "string" && (lower.includes("base64") || lower.includes("b64") || item.startsWith("data:image/"))) {
        return [key, `[image data omitted, ${item.length} chars]`];
      }
      if (key === "url" && typeof item === "string" && item.length > 220) {
        return [key, `${item.slice(0, 220)}...`];
      }
      return [key, maskLargeValues(item)];
    }),
  );
}

async function putJob(env, jobId, payload) {
  await env.IMAGE2_JOBS.put(jobKey(jobId), JSON.stringify(payload), {
    expirationTtl: JOB_TTL_SECONDS,
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

  const response = await fetch(image.value, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "image2-cloudflare-queue/1.0",
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

async function processJob(message, env) {
  const { jobId, payload, token } = message.body || {};
  const startedAt = Date.now();
  if (!jobId || !payload) return;

  await putJob(env, jobId, {
    ok: true,
    jobId,
    status: "processing",
    message: "后台任务已开始生成图片。",
    updatedAt: new Date().toISOString(),
  });

  const prompt = String(payload.prompt || "").trim();
  const authToken = String(token || env.IMAGE2_API_TOKEN || "").trim();
  if (!prompt) throw new Error("Prompt is empty.");
  if (!authToken) throw new Error("IMAGE2_API_TOKEN is not configured.");

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

  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      Authorization: authToken.toLowerCase().startsWith("bearer ") ? authToken : `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
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

  await putJob(env, jobId, {
    ok: upstream.ok,
    jobId,
    status: upstream.ok && image ? "completed" : "failed",
    statusCode: upstream.status,
    statusText: upstream.statusText,
    elapsedMs: Date.now() - startedAt,
    updatedAt: new Date().toISOString(),
    request: {
      url: target.toString(),
      body: { ...body, prompt: `[omitted, ${prompt.length} chars]` },
    },
    data: maskLargeValues(data),
    image,
    imageError,
  });
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processJob(message, env);
        message.ack();
      } catch (error) {
        const jobId = message.body?.jobId;
        if (jobId) {
          await putJob(env, jobId, {
            ok: false,
            jobId,
            status: "failed",
            error: error.message,
            errorName: error.name,
            updatedAt: new Date().toISOString(),
          });
        }
        message.ack();
      }
    }
  },

  async fetch() {
    return new Response("reccloud image2 queue worker", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
