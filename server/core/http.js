'use strict';
/**
 * Minimal HTTP kernel: router, middleware pipeline, body parsing, cookies,
 * static file serving and the security header suite.
 *
 * This exists instead of Express so the application ships with **zero runtime
 * dependencies** — no supply-chain surface, no version drift, and a container
 * image that is just Node plus source. The API surface is deliberately
 * Express-shaped (`app.get`, `req.params`, `res.json`) so the codebase remains
 * familiar and could be ported to Express by swapping this one file.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const config = require('../config');
const logger = require('./logger');
const { AppError, notFound, badRequest, payloadTooLarge, internal } = require('./errors');
const { uuid } = require('./crypto');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

/** Parse a Cookie header into a plain object. */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Serialise a Set-Cookie header value with secure defaults. */
function serialiseCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.expires) segments.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) segments.push('HttpOnly');
  if (options.sameSite !== null) segments.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  // Secure is mandatory in production; omitted locally so http://localhost works.
  if (options.secure ?? config.isProd) segments.push('Secure');
  return segments.join('; ');
}

/** The response helper attached to every request. */
class Response {
  constructor(res, req) {
    this.raw = res;
    this.req = req;
    this.statusCode = 200;
    this.headersSent = false;
    this.cookies = [];
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  header(name, value) {
    this.raw.setHeader(name, value);
    return this;
  }

  cookie(name, value, options) {
    this.cookies.push(serialiseCookie(name, value, options));
    this.raw.setHeader('Set-Cookie', this.cookies);
    return this;
  }

  clearCookie(name, options = {}) {
    return this.cookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
  }

  /** Send a JSON body, transparently gzipping when worthwhile. */
  json(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.header('Content-Type', 'application/json; charset=utf-8');
    return this.#send(body);
  }

  text(body, contentType = 'text/plain; charset=utf-8') {
    this.header('Content-Type', contentType);
    return this.#send(Buffer.from(String(body), 'utf8'));
  }

  noContent() {
    this.statusCode = 204;
    this.headersSent = true;
    this.raw.writeHead(204);
    this.raw.end();
  }

  #send(buffer) {
    if (this.headersSent) return this;
    const accepts = String(this.req.headers['accept-encoding'] ?? '');
    const type = String(this.raw.getHeader('Content-Type') ?? '');
    const shouldGzip = buffer.length > 1024 && COMPRESSIBLE.test(type) && accepts.includes('gzip');
    const payload = shouldGzip ? zlib.gzipSync(buffer, { level: 6 }) : buffer;
    if (shouldGzip) this.raw.setHeader('Content-Encoding', 'gzip');
    this.raw.setHeader('Content-Length', payload.length);
    this.headersSent = true;
    this.raw.writeHead(this.statusCode);
    // HEAD responses carry headers but no body.
    if (this.req.method === 'HEAD') this.raw.end();
    else this.raw.end(payload);
    return this;
  }
}

/**
 * Read and parse the request body with a hard byte ceiling enforced *during*
 * streaming, so an oversized upload is aborted rather than buffered.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers['content-length'] ?? '0', 10);
    if (Number.isFinite(declared) && declared > config.server.maxBodyBytes) {
      return reject(payloadTooLarge());
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.server.maxBodyBytes) {
        req.destroy();
        return reject(payloadTooLarge());
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] ?? '');
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(raw));
        if (type.includes('application/x-www-form-urlencoded')) {
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
        // Be permissive: attempt JSON regardless of a missing content-type.
        return resolve(raw.trim().startsWith('{') ? JSON.parse(raw) : {});
      } catch {
        return reject(badRequest('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Compile `/api/battles/:id/action` into a matcher with named groups. */
function compileRoute(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '/([^/]+)';
      }
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return { regex: new RegExp(`^${source || '/'}/?$`), keys };
}

class Application {
  constructor() {
    this.routes = [];
    this.middlewares = [];
    this.staticMounts = [];
    this.notFoundHandler = null;
  }

  /** Register a middleware: `(req, res, next) => void | Promise<void>`. */
  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  #register(method, pattern, handlers) {
    const { regex, keys } = compileRoute(pattern);
    this.routes.push({ method, pattern, regex, keys, handlers: handlers.flat() });
    return this;
  }

  get(pattern, ...handlers) { return this.#register('GET', pattern, handlers); }
  post(pattern, ...handlers) { return this.#register('POST', pattern, handlers); }
  put(pattern, ...handlers) { return this.#register('PUT', pattern, handlers); }
  patch(pattern, ...handlers) { return this.#register('PATCH', pattern, handlers); }
  delete(pattern, ...handlers) { return this.#register('DELETE', pattern, handlers); }

  /**
   * Serve a directory of static assets.
   * @param {string} urlPrefix   e.g. '/'
   * @param {string} directory   Absolute path on disk.
   * @param {object} options     `{ spaFallback: 'index.html', immutable: bool }`
   */
  static(urlPrefix, directory, options = {}) {
    this.staticMounts.push({ urlPrefix, directory: path.resolve(directory), options });
    return this;
  }

  /** Attempt to satisfy a request from a static mount. @returns {boolean} handled */
  async #serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    for (const mount of this.staticMounts) {
      if (!req.path.startsWith(mount.urlPrefix)) continue;
      const relative = req.path.slice(mount.urlPrefix.length) || 'index.html';
      // Resolve then verify containment: blocks `../` traversal absolutely.
      const candidate = path.resolve(mount.directory, relative.replace(/^\/+/, ''));
      if (candidate !== mount.directory && !candidate.startsWith(mount.directory + path.sep)) {
        continue;
      }
      let target = candidate;
      let stat = await fsp.stat(target).catch(() => null);
      if (stat?.isDirectory()) {
        target = path.join(target, 'index.html');
        stat = await fsp.stat(target).catch(() => null);
      }
      // Single-page-app fallback: unknown non-asset paths render the shell.
      if (!stat && mount.options.spaFallback && !path.extname(relative)) {
        target = path.join(mount.directory, mount.options.spaFallback);
        stat = await fsp.stat(target).catch(() => null);
      }
      if (!stat?.isFile()) continue;

      const ext = path.extname(target).toLowerCase();
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const etag = `W/"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;

      if (req.headers['if-none-match'] === etag) {
        res.raw.writeHead(304, { ETag: etag });
        res.raw.end();
        return true;
      }

      const isHashed = /\.[0-9a-f]{8,}\./.test(path.basename(target));
      const cacheControl = mount.options.immutable && isHashed
        ? 'public, max-age=31536000, immutable'
        : ext === '.html'
          ? 'no-cache'
          : 'public, max-age=300, must-revalidate';

      const headers = { 'Content-Type': mime, ETag: etag, 'Cache-Control': cacheControl };
      const accepts = String(req.headers['accept-encoding'] ?? '');
      const useGzip = COMPRESSIBLE.test(mime) && accepts.includes('gzip') && stat.size > 1024;

      if (useGzip) headers['Content-Encoding'] = 'gzip';
      else headers['Content-Length'] = stat.size;

      res.raw.writeHead(200, headers);
      res.headersSent = true;
      if (req.method === 'HEAD') { res.raw.end(); return true; }

      const stream = fs.createReadStream(target);
      if (useGzip) await pipeline(stream, zlib.createGzip({ level: 6 }), res.raw);
      else await pipeline(stream, res.raw);
      return true;
    }
    return false;
  }

  /** Convert any thrown value into a correct, safe HTTP response. */
  #handleError(err, req, res) {
    const log = req.log ?? logger;
    if (err instanceof AppError && err.expose) {
      if (err.status >= 500) log.error(err.message, { code: err.code, err });
      else log.debug('Request rejected', { code: err.code, status: err.status, msg: err.message });
      if (err.details?.retryAfter) res.header('Retry-After', String(err.details.retryAfter));
      if (!res.headersSent) res.status(err.status).json(err.toJSON());
      return;
    }
    log.error('Unhandled exception', { err, path: req.path, method: req.method });
    if (!res.headersSent) res.status(500).json(internal().toJSON());
  }

  /** The Node request listener. */
  handler() {
    return async (rawReq, rawRes) => {
      const started = process.hrtime.bigint();
      const requestId = rawReq.headers['x-request-id']?.slice(0, 64) || uuid();

      let url;
      try {
        url = new URL(rawReq.url, `http://${rawReq.headers.host ?? 'localhost'}`);
      } catch {
        rawRes.writeHead(400).end();
        return;
      }

      const req = rawReq;
      req.requestId = requestId;
      req.path = decodeURIComponent(url.pathname);
      req.query = Object.fromEntries(url.searchParams);
      req.cookies = parseCookies(rawReq.headers.cookie);
      req.params = {};
      req.body = {};
      req.ip = config.server.trustProxy
        ? String(rawReq.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
          rawReq.socket.remoteAddress
        : rawReq.socket.remoteAddress;
      req.log = logger.child({ requestId });

      const res = new Response(rawRes, req);
      res.header('X-Request-Id', requestId);

      rawRes.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const level = rawRes.statusCode >= 500 ? 'error' : rawRes.statusCode >= 400 ? 'warn' : 'debug';
        req.log[level](`${req.method} ${req.path} ${rawRes.statusCode}`, {
          ms: Math.round(ms * 100) / 100,
        });
      });

      try {
        // 1. Global middleware chain (security headers, CORS, rate limit, session).
        for (const mw of this.middlewares) {
          let advanced = false;
          await mw(req, res, () => { advanced = true; });
          if (!advanced) return; // middleware terminated the response
        }

        // 2. Route matching.
        let allowedMethods = null;
        for (const route of this.routes) {
          const match = route.regex.exec(req.path);
          if (!match) continue;
          if (route.method !== req.method && !(route.method === 'GET' && req.method === 'HEAD')) {
            (allowedMethods ??= new Set()).add(route.method);
            continue;
          }
          route.keys.forEach((key, i) => { req.params[key] = decodeURIComponent(match[i + 1]); });
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            req.body = await readBody(req);
          }
          for (const handler of route.handlers) {
            let advanced = false;
            await handler(req, res, () => { advanced = true; });
            if (!advanced) return;
          }
          return; // handler chain exhausted without responding
        }

        // 3. Static assets.
        if (await this.#serveStatic(req, res)) return;

        // 4. Method-not-allowed vs not-found.
        if (allowedMethods) {
          res.header('Allow', [...allowedMethods].join(', '));
          throw new AppError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not supported on this route.`);
        }
        if (this.notFoundHandler) return void (await this.notFoundHandler(req, res));
        throw notFound(`No route matches ${req.method} ${req.path}`);
      } catch (err) {
        this.#handleError(err, req, res);
      }
    };
  }

  /** Create the server without binding (useful for supertest-style testing). */
  createServer() {
    const server = http.createServer(this.handler());
    server.requestTimeout = config.server.requestTimeoutMs;
    server.headersTimeout = config.server.requestTimeoutMs + 5000;
    server.keepAliveTimeout = 65_000;
    return server;
  }
}

module.exports = { Application, Response, parseCookies, serialiseCookie, readBody, MIME_TYPES };
