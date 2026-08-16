#!/usr/bin/env node
/**
 * Local development server for Web FindXeink F15.
 *
 * Serves this directory to a phone on the same Wi-Fi. Zero dependencies, Node
 * 18+. It exists only for development — the released app is a pure static site
 * with no server component at all, which is why there is no API here.
 *
 * Why HTTPS: navigator.bluetooth only exists in a "secure context". A plain
 * http://192.168.x.x origin is not one, so the API is simply undefined there —
 * no error, no prompt, nothing to debug. So we generate a self-signed
 * certificate covering every LAN IP of this machine and serve over TLS; Chrome
 * shows a one-time interstitial you click through. Plain HTTP is served as well,
 * but only so the phone reaches a page that explains this.
 *
 * Environment: HTTP_PORT (8080), HTTPS_PORT (8443), SECURITY_HEADERS=0 to drop
 * the production headers if you need to rule them out while debugging.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(ROOT, 'certs');
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);

/**
 * The exact headers the hosts in _headers / vercel.json send, so a
 * CSP or Permissions-Policy mistake blows up here rather than after deploy.
 * Keep these three files in step; _headers carries the reasoning.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'permissions-policy':
    'accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), display-capture=(), ' +
    'geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), ' +
    'microphone=(), midi=(), payment=(), serial=(), usb=(), bluetooth=(self), screen-wake-lock=(self)',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

const WITH_SECURITY_HEADERS = process.env.SECURITY_HEADERS !== '0';

// ---------------------------------------------------------------- LAN address

/**
 * Every non-internal IPv4 address of this machine, best candidate first.
 *
 * @returns {Array<{name: string, address: string}>} Interface name and address.
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      // 169.254.x.x is a link-local address handed out when DHCP failed; the
      // phone will never reach it.
      if (a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  // Prefer real Wi-Fi/Ethernet over virtual adapters (VirtualBox, VMware, WSL,
  // Hyper-V, Docker, overlay VPNs), because the phone can only reach the former.
  // The first URL printed is the one people will actually type, so getting this
  // order right is the difference between "it works" and a connection timeout
  // nobody can explain.
  const virtualName = /virtualbox|vmware|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier/i;
  // Windows renames adapters — a stock VirtualBox host-only interface shows up
  // as plain "Ethernet 3" — so the name test alone is not enough. These three
  // subnets are the fixed defaults those tools assign themselves, and no
  // household router hands them out. Deliberately not the whole 172.16/12 block:
  // real corporate LANs live there, and Docker's own interfaces are caught by
  // name (docker0, vEthernet) already.
  const virtualNet = /^(192\.168\.56\.|192\.168\.99\.|10\.211\.55\.)/;
  const isVirtual = (a) => (virtualName.test(a.name) || virtualNet.test(a.address) ? 1 : 0);
  out.sort((a, b) => {
    const av = isVirtual(a);
    const bv = isVirtual(b);
    if (av !== bv) return av - bv;
    return a.address.localeCompare(b.address);
  });
  return out;
}

// ----------------------------------------------------------------- TLS certs

/**
 * Locate an openssl binary. Windows has none in PATH by default, but Git for
 * Windows ships one, and almost anyone working on this already has Git.
 *
 * @returns {string|null} Path to a working openssl, or null if there is none.
 */
function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl',
    '/opt/homebrew/bin/openssl',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'pipe' });
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Load the dev certificate, generating it when missing or stale.
 *
 * The certificate must list every LAN IP in its subjectAltName, otherwise some
 * Chrome versions refuse even to offer the "Proceed anyway" escape hatch. The
 * SAN list is stamped into a sidecar file so the certificate is regenerated
 * whenever this machine's addresses change (new Wi-Fi network, new DHCP lease).
 *
 * @param {Array<{name: string, address: string}>} addresses LAN addresses to cover.
 * @returns {{key: Buffer, cert: Buffer, regenerated: boolean}|null} TLS material, or null if openssl is missing.
 */
function ensureCert(addresses) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const stampFile = path.join(CERT_DIR, 'san.txt');

  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map((a) => `IP:${a.address}`)];
  const stamp = sans.join(',');

  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(stampFile)) {
    if (fs.readFileSync(stampFile, 'utf8').trim() === stamp) {
      return {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
        regenerated: false,
      };
    }
  }

  const openssl = findOpenssl();
  if (!openssl) return null;

  fs.mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(
    openssl,
    [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', keyFile,
      '-out', certFile,
      // 825 days is the maximum lifetime browsers will accept for a leaf cert.
      '-days', '825',
      '-subj', '/CN=web-findxeink-f15.local',
      '-addext', `subjectAltName=${stamp}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdio: 'pipe' },
  );
  fs.writeFileSync(stampFile, stamp);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), regenerated: true };
}

// -------------------------------------------------------------- static assets

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Serve the manifest with the right type or the browser ignores it outright.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  // Search engines reject a sitemap served as application/octet-stream.
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Page shown when the phone lands on plain http:// — the tool cannot work there.
 *
 * @param {Array<{name: string, address: string}>} addresses LAN addresses to link to.
 * @returns {string} A self-contained HTML document.
 */
function insecurePage(addresses) {
  const links = addresses
    .map(
      (a) =>
        `<li><a href="https://${a.address}:${HTTPS_PORT}/">https://${a.address}:${HTTPS_PORT}/</a>` +
        ` <small>(${a.name})</small></li>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Use HTTPS</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
 a{color:#7cc4ff} code{background:#1c2430;padding:2px 6px;border-radius:4px}
 .warn{background:#3a2a12;border:1px solid #7a5a22;padding:14px;border-radius:8px}
 li{margin:10px 0}
</style></head><body>
<h1>You are on plain HTTP</h1>
<div class="warn"><b>Web Bluetooth does not exist on <code>http://</code> origins.</b>
<code>navigator.bluetooth</code> is undefined here, so the app cannot talk to your display.</div>
<h2>Open one of these instead</h2>
<ul>${links}</ul>
<p>Chrome will warn that the certificate is not trusted &mdash; expected, it was generated locally by
your own PC. Tap <b>Advanced</b> &rarr; <b>Proceed to &hellip; (unsafe)</b>.</p>
</body></html>`;
}

/** @param {http.IncomingMessage} req Request to inspect. @returns {boolean} True if the Host is a loopback name. */
function isLoopbackHost(req) {
  const host = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  // http://localhost IS a secure context even without TLS, so the signpost below
  // would be actively misleading there.
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Resolve a URL path to a file inside ROOT, refusing anything that escapes it.
 *
 * @param {string} pathname Decoded URL pathname.
 * @returns {string|null} Absolute path inside ROOT, or null if it escapes.
 */
function resolveInsideRoot(pathname) {
  if (pathname.includes('\0')) return null;
  // Resolving './' + pathname rather than pathname itself keeps an absolute
  // Windows path in the URL ("/C:/…") from being honoured as one.
  const file = path.resolve(ROOT, '.' + pathname);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return file;
}

/**
 * Serve one file request.
 *
 * @param {http.IncomingMessage} req Incoming request.
 * @param {http.ServerResponse} res Response to write.
 * @param {boolean} secure Whether this arrived over TLS.
 * @param {Array<{name: string, address: string}>} addresses LAN addresses, for the signpost page.
 * @returns {Promise<void>} Resolves once the response has been written.
 */
async function serveStatic(req, res, secure, addresses) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  // Plain HTTP is only useful as a signpost, and only for the page itself:
  // assets must still load so the phone can render that signpost.
  if (!secure && !isLoopbackHost(req) && (pathname === '/' || pathname === '/index.html')) {
    const body = insecurePage(addresses);
    // No CSP here on purpose: this page is inline-styled and dev-only, and the
    // production policy would strip it down to unreadable black-on-black.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  let file = resolveInsideRoot(pathname);
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  try {
    let stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file);
    }
    const data = await fsp.readFile(file);
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': String(data.length),
      // Never cache in dev. Without this a stale service worker or a stale
      // module hangs around for hours and you debug code you are not running.
      'cache-control': 'no-store',
    };
    if (WITH_SECURITY_HEADERS) Object.assign(headers, SECURITY_HEADERS);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + pathname);
  }
}

// ------------------------------------------------------------------- handler

/**
 * Build a request handler bound to one of the two listeners.
 *
 * @param {boolean} secure Whether this listener is the TLS one.
 * @param {Array<{name: string, address: string}>} addresses LAN addresses, for the signpost page.
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void} Node request handler.
 */
function handler(secure, addresses) {
  return (req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      const tag = secure ? 'https' : 'http ';
      console.log(`  ${tag} ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // The released app is a pure static site: there is nothing to POST to.
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    serveStatic(req, res, secure, addresses).catch((err) => {
      console.error('  !! handler error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    });
  };
}

/**
 * Start a server, reporting the common failure clearly instead of a stack trace.
 *
 * @param {http.Server|https.Server} server Server to start.
 * @param {number} port TCP port to bind.
 * @param {string} label Human label used in the error message.
 * @returns {void}
 */
function listen(server, port, label) {
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n  !! ${label} port ${port} is already in use.`);
      console.error(`  !! Stop the other process, or run:  ${label.toUpperCase()}_PORT=1234 node serve.js\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '0.0.0.0');
}

// ---------------------------------------------------------------------- main

/**
 * Print one aligned "URL   [adapter]" line per address, best candidate first.
 *
 * The first line is the one people will actually type, so it is called out: on a
 * machine with VirtualBox, WSL or a VPN installed there can be four addresses
 * here and only one of them is reachable from a phone.
 *
 * @param {Array<{name: string, address: string}>} addresses Sorted LAN addresses.
 * @param {string} scheme 'https' or 'http'.
 * @param {number} port Port the listener is bound to.
 * @returns {void}
 */
function printAddresses(addresses, scheme, port) {
  const rows = addresses.map((a) => ({ url: `${scheme}://${a.address}:${port}/`, name: a.name }));
  const width = rows.reduce((w, r) => Math.max(w, r.url.length), 0);
  rows.forEach((r, i) => {
    console.log(`     ${r.url.padEnd(width + 4)}[${r.name}]${i === 0 ? '   <-- try this one first' : ''}`);
  });
}

function main() {
  const addresses = lanAddresses();
  if (!addresses.length) {
    console.error('No LAN IPv4 address found — is this machine on a network?');
  }

  let tls = null;
  try {
    tls = ensureCert(addresses);
  } catch (e) {
    console.error('Certificate generation failed:', e.message);
  }

  listen(http.createServer(handler(false, addresses)), HTTP_PORT, 'http');

  const line = '='.repeat(64);
  console.log('\n' + line);
  console.log('  Web FindXeink F15 — local dev server');
  console.log(line);

  if (tls) {
    listen(
      https.createServer({ key: tls.key, cert: tls.cert }, handler(true, addresses)),
      HTTPS_PORT,
      'https',
    );
    console.log(`\n  Certificate: ${tls.regenerated ? 'generated' : 'reused'} (certs/cert.pem)`);
    console.log('\n  OPEN THIS ON YOUR PHONE (same Wi-Fi):\n');
    printAddresses(addresses, 'https', HTTPS_PORT);
    console.log('\n  Chrome will say "Your connection is not private".');
    console.log('  That is expected — the certificate was made by this PC seconds ago.');
    console.log('  Tap  Advanced  ->  Proceed to ... (unsafe).');
    console.log(`\n  On this PC:  https://localhost:${HTTPS_PORT}/`);
  } else {
    console.log('\n  !! Could not generate a TLS certificate (openssl not found).');
    console.log('  !! Web Bluetooth WILL NOT WORK over plain http:// on a LAN address.');
    console.log('  !! Install Git for Windows (it ships openssl), or use localhost only.\n');
    printAddresses(addresses, 'http', HTTP_PORT);
    console.log(`\n  On this PC:  http://localhost:${HTTP_PORT}/   (localhost is a secure context)`);
  }

  console.log('\n  Ctrl+C to stop.');
  console.log(line + '\n');
}

main();
