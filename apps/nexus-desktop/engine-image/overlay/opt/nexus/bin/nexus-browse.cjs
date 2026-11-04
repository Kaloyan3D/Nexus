#!/usr/bin/env node
// nexus-browse: open ONE page of a project in headless Chromium (its own sandbox stays on), run a short list of
// interactions, and write VISUAL EVIDENCE under --out: JPEG screenshots, the page's console/errors, title/status, a
// measured layout summary and a compact element outline, all in report.json.
//
// It is started by the Nexus broker (never by the model) with a URL the broker already validated, and it enforces the
// same policy inside the browser: every request the page makes is checked and anything outside
//   * file: URLs under --root (real paths, so a symlink cannot leave the project)
//   * http://127.0.0.1:<port> for a port given with --allow-port
//   * data: / blob: / about:blank
// is aborted and listed under `blockedRequests`. No downloads, popups, permissions or service workers.
//
//   nexus-browse --url URL --out DIR --root DIR [--allow-port N ...] [--steps FILE] [--viewport desktop|mobile]
//                [--full-page] [--max-image-bytes N] [--timeout MS]
//
// steps.json: [{"do":"click","selector":"text=Add"},{"do":"fill","selector":"#q","value":"x"},{"do":"press","key":"Enter"},
//              {"do":"wait","ms":300},{"do":"expect","text":"Done"},{"do":"screenshot","name":"after"}]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('/usr/local/lib/node_modules/playwright-core')); }

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function args(name) { const o = []; process.argv.forEach((a, i) => { if (a === '--' + name) o.push(process.argv[i + 1]); }); return o; }
const url = arg('url'); const out = arg('out'); const rootArg = arg('root');
if (!url || !out || !rootArg) { console.error('usage: nexus-browse --url URL --out DIR --root DIR [--allow-port N] [--steps FILE]'); process.exit(64); }
const u = new URL(url);
if (!['http:', 'file:'].includes(u.protocol)) { console.error('only http(s) loopback or file URLs'); process.exit(64); }
const root = fs.realpathSync(rootArg);
const allowPorts = new Set(args('allow-port').map(Number).filter((n) => n > 0 && n < 65536));
const VIEWPORTS = { desktop: { width: 1280, height: 800, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };
const vpName = arg('viewport', 'desktop') in VIEWPORTS ? arg('viewport', 'desktop') : 'desktop';
const vp = VIEWPORTS[vpName];
const timeout = Math.min(+arg('timeout', 8000), 15000);
const fullPage = process.argv.includes('--full-page');
const maxImageBytes = Math.min(+arg('max-image-bytes', 120 * 1024), 400 * 1024);
const steps = arg('steps') ? JSON.parse(fs.readFileSync(arg('steps'), 'utf8')).slice(0, 12) : [];
fs.mkdirSync(out, { recursive: true });

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, n);

function allowed(raw) {
  let r; try { r = new URL(raw); } catch { return false; }
  if (r.protocol === 'data:' || r.protocol === 'blob:' || raw === 'about:blank') return true;
  if (r.protocol === 'file:') {
    try { const p = fs.realpathSync(decodeURIComponent(r.pathname)); return p === root || p.startsWith(root + path.sep); } catch { return false; }
  }
  if (r.protocol === 'http:' && (r.hostname === '127.0.0.1' || r.hostname === 'localhost')) return allowPorts.has(Number(r.port || 80));
  return false;
}

(async () => {
  const t0 = Date.now();
  const report = {
    url, viewport: { name: vpName, width: vp.width, height: vp.height }, startedAt: new Date().toISOString(),
    screenshots: [], console: [], pageErrors: [], failedRequests: [], blockedRequests: [], steps: [], ok: true,
  };
  // Chromium's own sandbox is NOT disabled. Defence in depth for egress: the request filter below only sees HTTP, so
  // everything that is not loopback is also sent to a closed proxy (WebSocket, fetch from workers, prefetch), and WebRTC
  // may not use direct UDP. Loopback is exempt from proxying by default, and the filter limits it to the allowed ports.
  const browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:9', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', '--no-pings'],
  });
  report.launched = true; report.launchMs = Date.now() - t0;
  try {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1,
      isMobile: vp.mobile, hasTouch: vp.mobile, acceptDownloads: false, serviceWorkers: 'block', permissions: [],
    });
    await ctx.route('**/*', (route) => {
      const r = route.request().url();
      if (allowed(r)) return route.continue();
      if (report.blockedRequests.length < 20) report.blockedRequests.push(clean(r, 200));
      return route.abort('blockedbyclient');
    });
    // WebSockets are not requests the filter sees: refuse them all (a preview's live-reload socket is not evidence).
    if (typeof ctx.routeWebSocket === 'function') await ctx.routeWebSocket(/.*/, (ws) => { report.blockedRequests.push(clean(ws.url(), 200)); ws.close(); });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeout);
    page.on('popup', (p) => p.close().catch(() => {}));
    page.on('console', (m) => { if (report.console.length < 40) report.console.push({ type: m.type(), text: clean(m.text(), 300) }); });
    page.on('pageerror', (e) => { if (report.pageErrors.length < 20) report.pageErrors.push(clean(e, 300)); });
    page.on('requestfailed', (r) => { if (report.failedRequests.length < 20 && !String(r.failure()?.errorText).includes('blockedbyclient')) report.failedRequests.push({ url: clean(r.url(), 200), error: clean(r.failure()?.errorText, 80) }); });

    // JPEG, shrunk until it fits the byte limit: the stored bytes ARE the evidence and what a vision model is shown.
    const shot = async (name) => {
      const idx = report.screenshots.length + 1;
      const file = path.join(out, `${String(idx).padStart(2, '0')}-${clean(name, 40).replace(/[^\w.-]/g, '_')}.jpg`);
      let quality = 78, buf;
      for (let attempt = 0; attempt < 5; attempt++) {
        buf = await page.screenshot({ type: 'jpeg', quality, fullPage: fullPage && attempt < 3, animations: 'disabled' });
        if (buf.length <= maxImageBytes) break;
        quality = Math.max(35, quality - 14);
        if (attempt === 2) { await page.setViewportSize({ width: Math.round(vp.width * 0.75), height: Math.round(vp.height * 0.75) }); }
      }
      if (buf.length > maxImageBytes) { report.screenshots.push({ name, error: 'too-large', bytes: buf.length }); return; }
      fs.writeFileSync(file, buf);
      const dim = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      report.screenshots.push({ name: clean(name, 40), file: path.basename(file), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mediaType: 'image/jpeg', quality, viewportW: dim.w, viewportH: dim.h, takenAt: new Date().toISOString() });
    };

    const resp = await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    report.status = resp ? resp.status() : null;
    report.loaded = !!resp && (resp.ok() || u.protocol === 'file:');
    report.title = clean(await page.title(), 200);
    await shot('loaded');
    for (const [i, s] of steps.entries()) {
      const rec = { i, do: clean(s.do, 12), ok: true };
      const t = Date.now();
      try {
        if (s.do === 'click') await page.click(String(s.selector || ''), { timeout });
        else if (s.do === 'fill') await page.fill(String(s.selector || ''), clean(s.value, 500), { timeout });
        else if (s.do === 'press') await page.keyboard.press(clean(s.key, 32));
        else if (s.do === 'wait') await page.waitForTimeout(Math.min(+s.ms || 0, 5000));
        else if (s.do === 'expect') await page.waitForSelector(`text=${clean(s.text, 200)}`, { timeout: Math.min(+s.ms || 4000, timeout), state: 'visible' });
        else if (s.do === 'screenshot') await shot(s.name || `step${i}`);
        else throw new Error('unknown step');
      } catch (e) { rec.ok = false; rec.error = clean(String(e.message || e).split('\n')[0], 160); report.ok = false; }
      rec.ms = Date.now() - t;
      if (s.selector) rec.selector = clean(s.selector, 80);
      report.steps.push(rec);
    }
    if (steps.length && !steps.some((s) => s.do === 'screenshot')) await shot('final');

    // What the page looks like, measured (numbers) plus a bounded outline (untrusted text).
    report.layout = await page.evaluate((intendedW) => {
      const de = document.documentElement;
      const imgs = [...document.images];
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollHeight: de.scrollHeight, intendedWidth: intendedW,
        // measured against the viewport the caller asked for: a mobile browser quietly widens its layout viewport to fit
        // overflowing content, which would otherwise hide the overflow
        horizontalOverflow: Math.max(de.scrollWidth, innerWidth) > intendedW,
        overflowPx: Math.max(0, Math.max(de.scrollWidth, innerWidth) - intendedW),
        hasViewportMeta: !!document.querySelector('meta[name=viewport]'),
        images: imgs.length, brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
        bodyFontPx: parseFloat(getComputedStyle(document.body).fontSize) || null,
        bodyColor: getComputedStyle(document.body).color, bodyBackground: getComputedStyle(document.body).backgroundColor,
      };
    }, vp.width);
    report.outline = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const out = [];
      for (const el of document.querySelectorAll('h1,h2,h3,nav,header,main,section,footer,a,button,input,textarea,select,img,form')) {
        if (out.length >= 60) break;
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.alt || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 60), box: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)] });
      }
      return out;
    });
    report.text = clean(await page.evaluate(() => (document.body ? document.body.innerText : '')), 1500);
    report.ok = report.ok && report.pageErrors.length === 0 && report.screenshots.some((s) => s.sha256);
  } catch (e) {
    report.ok = false; report.error = clean(String(e.message || e).split('\n')[0], 200);
  } finally {
    await browser.close().catch(() => {});
    report.totalMs = Date.now() - t0;
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report));
  console.log(JSON.stringify({ ok: report.ok, screenshots: report.screenshots.length, pageErrors: report.pageErrors.length, totalMs: report.totalMs }));
  process.exit(0);
})().catch((e) => {
  try { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: false, launched: false, error: clean(String(e.message || e).split('\n')[0], 300), screenshots: [] })); } catch { /* nothing more to do */ }
  process.exit(0);
});
