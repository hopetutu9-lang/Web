import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import core from "./core.js";

const ROOT = process.cwd();
const BUILT_DIR = path.join(ROOT, "dist", "public");
const STATIC_DIR = existsSync(path.join(BUILT_DIR, "index.html")) ? BUILT_DIR : ROOT;
const MAX_BODY_BYTES = 512 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://fstream.binance.com wss://stream.binancefuture.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  if (!["POST", "PATCH", "PUT"].includes(request.method || "")) return undefined;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!bytes) return {};
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON");
    error.status = 400;
    throw error;
  }
}

async function serveStatic(request, response, url) {
  let requested = "/";
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (requested === "/") requested = "/index.html";
  let filename = requested.replace(/^\/+/, "");
  if (
    filename.includes("..") ||
    filename.includes("\\") ||
    filename.startsWith(".") ||
    /(?:config|data)(?:\.example)?\.json$/i.test(filename) ||
    filename.endsWith(".map")
  ) {
    response.writeHead(404).end();
    return;
  }
  let file = path.resolve(STATIC_DIR, filename);
  if (!file.startsWith(`${path.resolve(STATIC_DIR)}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    if (path.extname(filename)) {
      response.writeHead(404).end();
      return;
    }
    file = path.join(STATIC_DIR, "index.html");
  }
  try {
    const content = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=86400",
      "Content-Length": content.length,
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404).end();
  }
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  const host = request.headers.host || "localhost";
  let url;
  try {
    url = new URL(request.url || "/", `http://${host}`);
  } catch {
    sendJson(response, 400, { error: "Invalid request URL" });
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
    try {
      const body = await readBody(request);
      const result = await core.handleApi({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      sendJson(response, result.status, result.body, result.headers);
    } catch (error) {
      sendJson(response, error?.status || 500, {
        error: error?.status ? error.message : "The request could not be completed",
      });
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    return;
  }
  await serveStatic(request, response, url);
});

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("Invalid PORT value\n");
  process.exit(1);
}

await core.startServices();
server.listen(port, "0.0.0.0", () => {
  process.stderr.write(`Binance Futures Terminal listening on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

