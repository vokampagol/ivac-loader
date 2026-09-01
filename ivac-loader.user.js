// ==UserScript==
// @name         IVAC Appointment Loader
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      1.2
// @description  Loads the latest main.js from GitHub for appointment.ivacbd.com
// @author       vokampagol
// @match        https://appointment.ivacbd.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/vokampagol/ivac-loader/main/ivac-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/vokampagol/ivac-loader/main/ivac-loader.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Change these if your GitHub repo or branch name is different.
  const REPO = 'vokampagol/ivac-loader';
  const BRANCH = 'main';
  const FILE = 'main.js';

  // Cache-busting query string so Tampermonkey always fetches the newest code.
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}?_=${Date.now()}`;

  // Helper to append a script element. Returns true on success.
  function appendScriptElement(script) {
    const parent = document.head || document.documentElement || document.body || document;
    try {
      parent.appendChild(script);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Try loading via <script src>. If that fails, retry a few times, then fetch+blob.
  async function loadScriptWithRetry(scrUrl, retries = 2, retryDelay = 500) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await loadScriptOnce(scrUrl);
        return;
      } catch (err) {
        if (attempt < retries) {
          console.warn(`[IVAC Loader] load attempt ${attempt + 1} failed, retrying...`, err);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        throw err;
      }
    }
  }

  function loadScriptOnce(scrUrl) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scrUrl;
      script.type = 'application/javascript';
      script.async = false; // ensure execution order
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = (ev) => reject(new Error('Script load failed'));
      if (!appendScriptElement(script)) {
        reject(new Error('append failed'));
      }
    });
  }

  async function fetchAndInject(scrUrl) {
    const resp = await fetch(scrUrl, { cache: 'no-store', credentials: 'omit' });
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
    const code = await resp.text();
    const blob = new Blob([code], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const s = document.createElement('script');
    s.src = blobUrl;
    s.type = 'application/javascript';
    s.async = false;
    s.onload = () => URL.revokeObjectURL(blobUrl);
    if (!appendScriptElement(s)) {
      URL.revokeObjectURL(blobUrl);
      throw new Error('Failed to append blob script');
    }
  }

  // Top-level loader: try script tag with retries, then fetch+blob as fallback.
  loadScriptWithRetry(url, 2, 500)
    .then(() => console.log('[IVAC Loader] main.js loaded from', url))
    .catch((err) => {
      console.warn('[IVAC Loader] direct load failed, trying fetch fallback', err);
      return fetchAndInject(url)
        .then(() => console.log('[IVAC Loader] main.js loaded via fetch/blob'))
        .catch(e => console.error('[IVAC Loader] Could not load main.js:', e));
    });
>>>>>>> 020a8f0 (chore: bump ivac-loader.user.js version to 1.1 and add fixes/test harness)
})();
