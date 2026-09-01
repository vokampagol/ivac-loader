// ==UserScript==
// @name         IVAC Appointment Loader
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      1.0
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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.type = 'text/javascript';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load ' + src));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function init() {
    loadScript(url)
      .then(() => {
        console.log('[IVAC Loader] main.js loaded from:', url);
      })
      .catch((err) => {
        console.error('[IVAC Loader] Could not load main.js:', err);
        alert('[IVAC Loader] main.js load হয়নি। GitHub repo (vokampagol/ivac-loader) public আছে কিনা এবং main.js ফাইল আছে কিনা চেক করুন।');
      });
  }

  // Wait for the page to be ready so the panel can attach to <body>.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
