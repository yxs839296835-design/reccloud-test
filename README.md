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

Recommended deploy targets:

- Render Web Service
- Railway
- Vercel with a Node server adapter
- Any VPS or Node hosting platform

Start command:

```text
npm start
```
