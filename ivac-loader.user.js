// ==UserScript==
// @name         IVAC Appointment Loader
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      1.5
// @description  Loads the latest main.js from GitHub for appointment.ivacbd.com
// @author       vokampagol
// @match        https://appointment.ivacbd.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
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

  // Sources tried in order. raw.githubusercontent.com is the freshest (~5 min cache);
  // jsDelivr is only a backup if raw is blocked.
  const stamp = Date.now();
  const SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}?_=${stamp}`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}?_=${stamp}`,
  ];

  // Download the code through Tampermonkey (bypasses the page's CORS/CSP and the
  // "text/plain + nosniff" problem that stops <script src="raw.githubusercontent..."> from running).
  function download(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 15000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.responseText
          ? resolve(r.responseText)
          : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Run the downloaded code. Try several ways because sites with strict CSP block some of them.
  function run(code) {
    const errors = [];

    // 1) Tampermonkey-created <script> (CSP-safe), runs in the page context.
    try {
      if (typeof GM_addElement === 'function') {
        GM_addElement('script', { textContent: code });
        return 'GM_addElement';
      }
    } catch (e) { errors.push('GM_addElement: ' + e.message); }

    // 2) Plain inline <script>.
    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return 'inline script';
    } catch (e) { errors.push('inline: ' + e.message); }

    // 3) Run directly inside the userscript sandbox (not affected by page CSP).
    try {
      (0, eval)(code);
      return 'eval';
    } catch (e) { errors.push('eval: ' + e.message); }

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
      b.textContent = 'IVAC Loader v1.5: ' + text;
    } catch (e) {}
  }

  async function main() {
    badge('starting...', true);
    let lastErr;
    for (const url of SOURCES) {
      try {
        const code = await download(url);
        const how = run(code);
        console.log(TAG, `main.js loaded via ${how} from`, url.split('?')[0]);
        badge('main.js downloaded & executed (' + how + '). Checking panel...', true);
        window.addEventListener('error', (ev) => badge('PAGE ERROR: ' + ev.message, false));
        setTimeout(() => {
          const panel = document.getElementById('ivac-helper-panel');
          if (panel) { badge('OK - helper panel is on page', true); setTimeout(() => { const b = document.getElementById('ivac-loader-badge'); if (b) b.remove(); }, 5000); }
          else badge('main.js ran but PANEL NOT CREATED (see Console F12)', false);
        }, 2000);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(TAG, 'failed for', url.split('?')[0], '-', e.message);
        badge('FAILED ' + url.split('/')[2] + ': ' + e.message, false);
      }
    }
    console.error(TAG, 'Could not load main.js:', lastErr);
  }

  main();
})();
