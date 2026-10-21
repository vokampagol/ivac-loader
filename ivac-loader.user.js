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
  const stamp = Date.now();
  const SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}?_=${stamp}`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}?_=${stamp}`,
  ];

  function badge(text, ok) {
    try {
      let b = document.getElementById('ivac-loader-badge');
      if (!b) {
        b = document.createElement('div');
        b.id = 'ivac-loader-badge';
        b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:2147483647;padding:6px 12px;border-radius:8px;font:12px sans-serif;color:white;max-width:360px;cursor:pointer';
        b.onclick = () => b.remove();
        (document.body || document.documentElement).appendChild(b);
      }
      b.style.background = ok ? '#16a34a' : '#dc2626';
      b.textContent = 'IVAC Loader: ' + text;
    } catch (e) {}
  }

  function isOurScriptError(ev) {
    const filename = ev && ev.filename ? String(ev.filename) : '';
    const message = ev && ev.message ? String(ev.message) : '';
    const helperOrigin = /raw\.githubusercontent\.com|cdn\.jsdelivr\.net|main\.js|ivac-loader/i.test(filename);
    const helperMessage = /IVAC Loader|ivac-helper-panel|IVAC Helper|GM_addElement/i.test(message);
    return helperOrigin || helperMessage;
  }

  function download(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 20000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.responseText) resolve(r.responseText);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function run(code) {
    try {
      if (typeof GM_addElement === 'function') {
        GM_addElement('script', { textContent: code });
        return 'GM_addElement';
      }
    } catch (e) {}

    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return 'inline';
    } catch (e) {}

    try {
      (0, eval)(code);
      return 'eval';
    } catch (e) {}

    throw new Error('No injection method worked');
  }

  async function main() {
    badge('starting...', true);
    let lastErr = null;

    for (const url of SOURCES) {
      try {
        const code = await download(url);
        const how = run(code);
        console.log(TAG, 'main.js loaded via', how, 'from', url);
        badge('main.js loaded - helper should appear', true);

        window.addEventListener('error', (ev) => {
          if (!isOurScriptError(ev)) return;
          badge('PAGE ERROR: ' + (ev.message || 'unknown runtime error'), false);
        }, true);

        setTimeout(() => {
          const panel = document.getElementById('ivac-helper-panel');
          if (panel) {
            badge('OK - helper panel visible', true);
            setTimeout(() => {
              const b = document.getElementById('ivac-loader-badge');
              if (b) b.remove();
            }, 4000);
          } else {
            badge('Loaded but panel not found', false);
          }
        }, 1500);

        return;
      } catch (e) {
        lastErr = e;
        console.warn(TAG, 'Failed:', url, e.message);
      }
    }

    console.error(TAG, 'Could not load main.js', lastErr);
    badge('Failed to load main.js', false);
  }

  main();
})();
