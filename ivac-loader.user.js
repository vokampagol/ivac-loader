// ==UserScript==
// @name         IVAC Appointment Loader
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      1.1
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

  function appendScriptElement(script) {
    const parent = document.head || document.documentElement || document.body || document;
    try {
      parent.appendChild(script);
      return true;
    } catch (e) {
      try {
        // Last resort: use document.write for very early document-start contexts
        document.write(script.outerHTML);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function loadScriptWithFallback(scrUrl) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scrUrl;
      script.type = 'application/javascript';
      script.async = false; // ensure execution order
      script.onload = () => resolve();
      script.onerror = async (ev) => {
        console.warn('[IVAC Loader] direct script load failed, trying fetch fallback', ev);
        try {
          const resp = await fetch(scrUrl, { cache: 'no-store', credentials: 'omit' });
          if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
          const code = await resp.text();
          const blob = new Blob([code], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          const blobScript = document.createElement('script');
          blobScript.src = blobUrl;
          blobScript.type = 'application/javascript';
          blobScript.async = false;
          blobScript.onload = () => {
            URL.revokeObjectURL(blobUrl);
            resolve();
          };
          blobScript.onerror = (e) => reject(new Error('Blob script failed: ' + e));
          if (!appendScriptElement(blobScript)) throw new Error('Failed to append blob script');
        } catch (err) {
          reject(err);
        }
      };

      if (!appendScriptElement(script)) {
        // If we couldn't append the element, try fetch fallback immediately
        script.onerror(new Error('append failed'));
      }
    });
  }

  loadScriptWithFallback(url)
    .then(() => console.log('[IVAC Loader] main.js loaded from', url))
    .catch((err) => console.error('[IVAC Loader] Could not load main.js:', err));
  function appendScriptElement(script) {
    const parent = document.head || document.documentElement || document.body || document;
    try {
      parent.appendChild(script);
      return true;
    } catch (e) {
      try {
        // Last resort: use document.write for very early document-start contexts
        document.write(script.outerHTML);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function loadScriptWithFallback(scrUrl) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scrUrl;
      script.type = 'application/javascript';
      script.async = false; // ensure execution order
      script.onload = () => resolve();
      script.onerror = async (ev) => {
        console.warn('[IVAC Loader] direct script load failed, trying fetch fallback', ev);
        try {
          const resp = await fetch(scrUrl, { cache: 'no-store', credentials: 'omit' });
          if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
          const code = await resp.text();
          const blob = new Blob([code], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          const blobScript = document.createElement('script');
          blobScript.src = blobUrl;
          blobScript.type = 'application/javascript';
          blobScript.async = false;
          blobScript.onload = () => {
            URL.revokeObjectURL(blobUrl);
            resolve();
          };
          blobScript.onerror = (e) => reject(new Error('Blob script failed: ' + e));
          if (!appendScriptElement(blobScript)) throw new Error('Failed to append blob script');
        } catch (err) {
          reject(err);
        }
      };

      if (!appendScriptElement(script)) {
        // If we couldn't append the element, try fetch fallback immediately
        script.onerror(new Error('append failed'));
      }
    });
  }

  loadScriptWithFallback(url)
    .then(() => console.log('[IVAC Loader] main.js loaded from', url))
    .catch((err) => console.error('[IVAC Loader] Could not load main.js:', err));
>>>>>>> 020a8f0 (chore: bump ivac-loader.user.js version to 1.1 and add fixes/test harness)
})();
