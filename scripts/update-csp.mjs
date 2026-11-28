import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pages = ['index.html', 'projekty.html'];
for (const directory of ['airdock', 'clipforge', 'epickeysimulator', 'homepage',
  'spotifydatapackage', 'tiktokdataorganiser', 'undertaleweb', 'vidcompress']) {
  for (const file of readdirSync(path.join(root, directory))) {
    if (file.endsWith('.html')) pages.push(directory + '/' + file);
  }
}

const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
for (const page of pages) {
  const file = path.join(root, page);
  const original = readFileSync(file, 'utf8');
  const hashes = [...original.replace(/\r\n?/g, '\n').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
    .map(([, , script]) => "'sha256-" + createHash('sha256').update(script).digest('base64') + "'");
  const ffmpeg = page.startsWith('vidcompress/');
  const wasm = ffmpeg || page.startsWith('undertaleweb/');
  const connect = ["'self'"];
  if (ffmpeg) connect.push('blob:');
  if (page.startsWith('airdock/')) connect.push('https://0.peerjs.com', 'wss://0.peerjs.com');
  if (page.startsWith('homepage/')) connect.push('https://api.open-meteo.com');
  const policy = [
    "default-src 'none'",
    ["script-src 'self'", ...(ffmpeg ? ['blob:'] : []), ...(wasm ? ["'wasm-unsafe-eval'"] : []), ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    'connect-src ' + connect.join(' '),
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
  const tag = '<meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  const updated = meta.test(original) ? original.replace(meta, tag) :
    original.replace(/<meta\s+charset=[^>]*>/i, '$&' + (original.includes('\r\n') ? '\r\n' : '\n') + tag);
  if (updated === original) continue;
  if (process.argv.includes('--check')) {
    console.error('CSP needs regeneration in ' + page);
    process.exitCode = 1;
  } else {
    writeFileSync(file, updated);
  }
}
