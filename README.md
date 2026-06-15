# Image2 VIP 4K Test Page

This is a small Node.js app for testing `gpt-image-2-vip` image generation.

## Local Run

```powershell
$env:IMAGE2_API_TOKEN="your-token"
npm start
```

Open:

```text
http://localhost:5177
```

## Required Environment Variables

```text
IMAGE2_API_TOKEN=your-token
```

The token is intentionally not committed to this repository. The browser never receives the token; all image generation requests go through the local/server-side proxy.

## Deploy Notes

This project requires a Node.js runtime because GitHub Pages cannot safely store the API token or run the proxy endpoint.

For long-running 4K image generation, use Cloudflare Pages only for the frontend and deploy the Node API proxy to a long-running web service such as Render or Railway. Cloudflare Pages Functions are not recommended for the image generation proxy because long synchronous requests can hit edge/runtime limits.

Recommended deploy targets:

- Render Web Service
- Railway
- Vercel with a Node server adapter
- Any VPS or Node hosting platform

Start command:

```text
npm start
```

## Recommended Production Layout

```text
Cloudflare Pages
  Frontend + password gate

Render/Railway/VPS
  /api/image2-generate long-running Node proxy
```

After deploying the Node proxy, edit:

```text
public/runtime-config.js
```

Set:

```js
window.IMAGE2_API_ENDPOINT = "https://your-node-api.example.com/api/image2-generate";
```

Then redeploy Cloudflare Pages.
