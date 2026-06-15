const JOB_TTL_SECONDS = 60 * 60 * 24;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function jobKey(jobId) {
  return `image2:${jobId}`;
}

function requireBindings(env) {
  if (!env.IMAGE2_JOBS) throw new Error("IMAGE2_JOBS KV binding is not configured.");
  if (!env.IMAGE2_QUEUE) throw new Error("IMAGE2_QUEUE binding is not configured.");
}

function publicJob(job) {
  if (!job) return null;
  return {
    ...job,
    token: undefined,
  };
}

export function onRequestOptions() {
  return json({}, 204);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.IMAGE2_JOBS) throw new Error("IMAGE2_JOBS KV binding is not configured.");
    const url = new URL(request.url);
    const jobId = String(url.searchParams.get("jobId") || "").trim();
    if (!jobId) return json({ ok: false, error: "Missing jobId." }, 400);

    const job = await env.IMAGE2_JOBS.get(jobKey(jobId), "json");
    if (!job) {
      return json({
        ok: false,
        jobId,
        status: "not_found",
        error: "任务不存在或已过期。",
      }, 404);
    }

    return json(publicJob(job));
  } catch (error) {
    return json({ ok: false, error: error.message, errorName: error.name }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, error: `JSON parse failed: ${error.message}` }, 400);
  }

  const prompt = String(payload.prompt || "").trim();
  if (!prompt) return json({ ok: false, error: "Please enter a prompt." }, 400);

  try {
    requireBindings(env);
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  const token = String(env.IMAGE2_API_TOKEN || "").trim();
  if (!token) {
    return json({ ok: false, error: "IMAGE2_API_TOKEN is not configured in Cloudflare Pages." }, 500);
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    ok: true,
    queued: true,
    jobId,
    status: "queued",
    message: "任务已提交，后台正在排队生成。",
    createdAt: now,
    updatedAt: now,
    request: {
      model: payload.model || "gpt-image-2-vip",
      size: payload.size || "3840x2160",
      quality: payload.quality || "high",
      output_format: payload.output_format || "png",
      background: payload.background || "opaque",
      moderation: payload.moderation || "auto",
      promptLength: prompt.length,
    },
    statusUrl: `/api/image2-generate?jobId=${encodeURIComponent(jobId)}`,
  };

  await env.IMAGE2_JOBS.put(jobKey(jobId), JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });

  await env.IMAGE2_QUEUE.send({
    jobId,
    token,
    payload: {
      baseUrl: payload.baseUrl || "https://api.5spiritual.com",
      prompt,
      model: payload.model || "gpt-image-2-vip",
      size: payload.size || "3840x2160",
      background: payload.background || "opaque",
      moderation: payload.moderation || "auto",
      quality: payload.quality || "high",
      output_format: payload.output_format || "png",
    },
  });

  return json(job, 202);
}
