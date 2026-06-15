const COOKIE_NAME = "reccloud_image2_auth";
const COOKIE_VALUE = "ok";

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

function loginPage(message = "") {
  return html(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>访问验证</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
        color: #172033;
        background: #f3f7fb;
      }
      main {
        width: min(420px, calc(100vw - 32px));
        border: 1px solid #d7dfeb;
        border-radius: 8px;
        padding: 24px;
        background: #fff;
        box-shadow: 0 20px 60px rgba(23, 32, 51, 0.12);
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0 0 18px; color: #657186; line-height: 1.6; }
      label { display: grid; gap: 8px; color: #657186; font-size: 13px; font-weight: 700; }
      input {
        width: 100%;
        border: 1px solid #d7dfeb;
        border-radius: 8px;
        padding: 11px 12px;
        font: inherit;
      }
      button {
        width: 100%;
        min-height: 42px;
        margin-top: 16px;
        border: 1px solid #0f766e;
        border-radius: 8px;
        color: #fff;
        background: #0f766e;
        font: inherit;
        font-weight: 800;
      }
      .error {
        margin: 12px 0 0;
        border: 1px solid #f0aaa4;
        border-radius: 8px;
        padding: 10px;
        color: #b42318;
        background: #fff1f0;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>访问验证</h1>
      <p>请输入访问密码后进入 Image2 VIP 生成测试页。</p>
      <form method="post" action="/auth">
        <label>
          访问密码
          <input name="password" type="password" autocomplete="current-password" autofocus required />
        </label>
        <button type="submit">进入页面</button>
      </form>
      ${message ? `<div class="error">${message}</div>` : ""}
    </main>
  </body>
</html>`, status);
}

export async function onRequestPost({ request, env }) {
  const form = await request.formData();
  const password = String(form.get("password") || "");

  if (!env.ACCESS_PASSWORD) {
    return html("<h1>ACCESS_PASSWORD is not configured.</h1>", 500);
  }

  if (password !== env.ACCESS_PASSWORD) {
    return loginPage("密码错误，请重新输入。", 401);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
    },
  });
}

export function onRequestGet() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/" },
  });
}
