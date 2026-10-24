// ==UserScript==
// @name         IVAC Appointment Loader
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      1.7
// @description  Loads the latest main.js from GitHub for appointment.ivacbd.com
// @author       vokampagol
// @match        https://appointment.ivacbd.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      sms-sight-show.lovable.app
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/vokampagol/ivac-loader/main/ivac-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/vokampagol/ivac-loader/main/ivac-loader.user.js
// ==/UserScript==

(function () {
  'use strict';

  const REPO = 'vokampagol/ivac-loader';
  const BRANCH = 'main';
  const FILE = 'main.js';
  const TAG = '[IVAC Loader]';
  const VERSION = '1.7';

  // Sources tried in order. raw.githubusercontent.com is the freshest (~5 min cache);
  // jsDelivr is only a backup if raw is blocked.
  const stamp = Date.now();
  const SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}?_=${stamp}`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}?_=${stamp}`,
  ];

  // Download through Tampermonkey (bypasses the page's CORS/CSP and the
  // "text/plain + nosniff" problem that stops <script src="raw.githubusercontent..."> from running).
  function download(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: Object.assign({ 'Cache-Control': 'no-cache' }, extraHeaders),
        timeout: 15000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.responseText
          ? resolve(r.responseText)
          : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Bridge handed to main.js so it can use Tampermonkey storage (GM_setValue/GM_getValue)
  // and Tampermonkey HTTP (GM_xmlhttpRequest, used for the SMS/OTP API).
  const bridge = {
    get: (key, fallback) => GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
    http: ({ method = 'GET', url, headers = {} }) => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        timeout: 20000,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    }),
  };

  // Run the downloaded code. Several ways because sites with strict CSP block some of them.
  function run(code) {
    const errors = [];

    // 1) Inside the userscript sandbox with the GM bridge (not affected by page CSP).
    //    Compile errors fall through to the next method; runtime errors from main.js are reported, not retried.
    let fn = null;
    try {
      fn = new Function('__IVAC_GM__', code);
    } catch (e) { errors.push('sandbox compile: ' + e.message); }
    if (fn) {
      fn(bridge);
      return 'sandbox';
    }

    // 2) Page-context <script>. The bridge is exposed on the page window (best effort).
    try {
      try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__IVAC_GM__ = bridge; } catch (e) { /* ignore */ }
      if (typeof GM_addElement === 'function') {
        GM_addElement('script', { textContent: code });
        return 'GM_addElement';
      }
    } catch (e) { errors.push('GM_addElement: ' + e.message); }

    // 3) Plain inline <script>.
    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return 'inline script';
    } catch (e) { errors.push('inline: ' + e.message); }

    throw new Error(errors.join(' | '));
  }

  // Small on-page badge so you can see the loader status without opening DevTools.
  function badge(text, ok) {
    try {
      let b = document.getElementById('ivac-loader-badge');
      if (!b) {
        b = document.createElement('div');
        b.id = 'ivac-loader-badge';
        b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:6px;z-index:2147483647;padding:6px 10px;border-radius:6px;font:12px sans-serif;color:#fff;max-width:340px;cursor:pointer';
        b.title = 'click to hide';
        b.onclick = () => b.remove();
        (document.body || document.documentElement).appendChild(b);
      }
      b.style.background = ok ? '#16a34a' : '#dc2626';
      b.textContent = `IVAC Loader v${VERSION}: ` + text;
    } catch (e) { /* ignore */ }
  }

  // ---- private-repo support -------------------------------------------------------------
  // raw.githubusercontent.com answers 404 for a PRIVATE repo unless a token is sent.
  // Tampermonkey menu -> "IVAC: set GitHub token" stores a read-only token (GM storage, never in the repo).
  const TOKEN_KEY = 'ghToken';
  const CACHE_KEY = 'cachedMainJs';
  const getToken = () => { try { return String(GM_getValue(TOKEN_KEY, '') || '').trim(); } catch (e) { return ''; } };

  try {
    GM_registerMenuCommand('IVAC: set GitHub token (private repo)', () => {
      const t = window.prompt('Paste a GitHub token with READ access to Contents of ' + REPO + '\n(fine-grained token, Contents: Read-only). Leave empty to remove.', '');
      if (t === null) return;
      GM_setValue(TOKEN_KEY, t.trim());
      location.reload();
    });
  } catch (e) { /* menu not available */ }

  async function main() {
    badge('starting...', true);
    const token = getToken();
    const errors = [];
    let code = null;
    let source = '';

    for (const url of SOURCES) {
      const isRaw = url.includes('raw.githubusercontent.com');
      try {
        code = await download(url, isRaw && token ? { Authorization: 'token ' + token } : {});
        source = url.split('?')[0];
        break;
      } catch (e) {
        errors.push(`${url.split('/')[2]}: ${e.message}`);
        console.warn(TAG, 'download failed for', url.split('?')[0], '-', e.message);
      }
    }

    let usedCache = false;
    if (code) {
      try { GM_setValue(CACHE_KEY, code); } catch (e) { /* storage full - ignore */ }
    } else {
      // Offline / private repo without token: run the last copy that worked.
      let cached = '';
      try { cached = String(GM_getValue(CACHE_KEY, '') || ''); } catch (e) { /* ignore */ }
      if (cached) {
        code = cached;
        usedCache = true;
        source = 'cached copy';
      }
    }

    if (!code) {
      const priv = errors.some((m) => /HTTP 404/.test(m)) && !token;
      console.error(TAG, 'Could not load main.js:', errors);
      badge('FAILED (' + errors.join(' | ') + ')' + (priv ? ' - repo is PRIVATE: make it public or use Tampermonkey menu "IVAC: set GitHub token"' : ''), false);
      return;
    }

    try {
      const how = run(code);
      console.log(TAG, `main.js loaded via ${how} from`, source);
      badge('main.js executed (' + how + ', ' + source + '). Checking panel...', !usedCache);
      window.addEventListener('error', (ev) => badge('PAGE ERROR: ' + ev.message, false));
      setTimeout(() => {
        const panel = document.getElementById('ivac-helper-panel');
        if (panel) {
          badge(usedCache ? 'OK - using CACHED copy (GitHub not reachable: ' + errors[0] + ')' : 'OK - helper panel is on page', !usedCache);
          if (!usedCache) setTimeout(() => { const b = document.getElementById('ivac-loader-badge'); if (b) b.remove(); }, 5000);
        } else {
          badge('main.js ran but PANEL NOT CREATED (see Console F12)', false);
        }
      }, 2000);
    } catch (e) {
      console.error(TAG, 'main.js failed to run:', e);
      badge('main.js ERROR: ' + e.message, false);
    }
  }

  main();
})();
