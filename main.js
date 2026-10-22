(function () {
  'use strict';

  const log = (...args) => console.log('[IVAC Helper]', ...args);

  // ==========================================================
  // Environment bridge (Tampermonkey GM_* access)
  // The loader (ivac-loader.user.js) passes a bridge object as __IVAC_GM__.
  // If it is missing (e.g. test harness) we fall back to localStorage / fetch.
  // ==========================================================
  const GMX = (typeof __IVAC_GM__ !== 'undefined' && __IVAC_GM__) || window.__IVAC_GM__ || null;
  const HAS_GM_STORE = !!(GMX && typeof GMX.get === 'function' && typeof GMX.set === 'function');

  /** Persistent key/value store: GM_setValue/GM_getValue when available, else localStorage. */
  const store = {
    async get(key, fallback = '') {
      try {
        if (HAS_GM_STORE) {
          const v = await GMX.get(key, fallback);
          return v === undefined || v === null ? fallback : v;
        }
        const raw = localStorage.getItem('ivac_helper_' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        if (HAS_GM_STORE) await GMX.set(key, value);
        else localStorage.setItem('ivac_helper_' + key, JSON.stringify(value));
      } catch (e) {
        console.warn('[IVAC Helper] store.set failed', key, e);
      }
    },
  };

  /** HTTP GET through Tampermonkey (no CORS/CSP limits) or plain fetch as fallback. */
  async function httpGet(url, headers = {}) {
    if (GMX && typeof GMX.http === 'function') {
      return GMX.http({ method: 'GET', url, headers });
    }
    const r = await fetch(url, { headers, cache: 'no-store', credentials: 'omit' });
    return { status: r.status, text: await r.text() };
  }

  // ==========================================================
  // LOG (shown in the LOG tab; also mirrored to the console)
  // ==========================================================
  const LOG_MAX = 200;
  const logLines = [];

  function renderLogLine(box, entry) {
    const row = document.createElement('div');
    row.className = 'ivac-log-line ' + entry.level;
    row.textContent = `[${entry.time}] ${entry.msg}`;
    box.appendChild(row);
  }

  /** Add a line to the LOG tab. Never pass secrets in here. */
  function addLog(msg, level = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), level, msg: String(msg) };
    logLines.push(entry);
    if (logLines.length > LOG_MAX) logLines.shift();
    log(entry.msg);
    const box = document.getElementById('ivac-log');
    if (box) {
      renderLogLine(box, entry);
      while (box.childNodes.length > LOG_MAX) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
  }

  function renderAllLogs() {
    const box = document.getElementById('ivac-log');
    if (!box) return;
    box.textContent = '';
    logLines.forEach((e) => renderLogLine(box, e));
    box.scrollTop = box.scrollHeight;
  }

  // ==========================================================
  // Settings (Device ID, API secret, API URL, OTP delay)
  // ==========================================================
  const DEFAULT_OTP_API = 'https://sms-sight-show.lovable.app/api/public/sms/latest';
  const settings = { deviceId: '', apiSecret: '', apiUrl: DEFAULT_OTP_API, otpDelaySec: 5 };

  async function loadSettings() {
    settings.deviceId = String(await store.get('deviceId', ''));
    settings.apiSecret = String(await store.get('apiSecret', ''));
    settings.apiUrl = String(await store.get('apiUrl', DEFAULT_OTP_API)) || DEFAULT_OTP_API;
    const d = Number(await store.get('otpDelaySec', 5));
    settings.otpDelaySec = Number.isFinite(d) && d >= 0 ? d : 5;
    if (!HAS_GM_STORE) addLog('GM storage not available - settings are kept in browser localStorage.', 'warn');
  }

  // ==========================================================
  // OTP: fetch latest SMS from the user's own SMS-forwarding API and parse the code
  // (No captcha/Cloudflare handling here. Only the user's own SMS is read.)
  // ==========================================================
  const OTP_LENGTH = 6;
  const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  // Number words separated by space, comma, dot, dash or underscore ("Nine_Two_Three_Four_Three_Eight").
  // Lookarounds instead of \b because "_" counts as a word character for \b.
  const WORD_RUN_RE = /(?:(?<![a-z])(?:zero|one|two|three|four|five|six|seven|eight|nine)(?![a-z])[\s,.\-\u2013\u2014_]*)+/gi;

  /**
   * Extract an OTP from SMS text.
   *  "Two-Six-Two-Seven-Eight-Zero" -> "262780"
   *  "Your OTP is 262780"           -> "262780"
   *  "2-6-2-7-8-0"                  -> "262780"
   * Returns '' when no OTP_LENGTH-digit code is found.
   */
  function parseOtp(text) {
    if (!text || typeof text !== 'string') return '';

    // 1) spelled-out digits
    const runs = text.match(WORD_RUN_RE) || [];
    for (const run of runs) {
      const words = run.toLowerCase().match(/zero|one|two|three|four|five|six|seven|eight|nine/g) || [];
      if (words.length === OTP_LENGTH) return words.map((w) => NUMBER_WORDS[w]).join('');
    }

    // 2) digits separated by - or space: "2-6-2-7-8-0"
    const sep = text.match(/(?<!\d)(?:\d[\s\-]){5}\d(?!\d)/);
    if (sep) {
      const digits = sep[0].replace(/\D/g, '');
      if (digits.length === OTP_LENGTH) return digits;
    }

    // 3) plain 6-digit number
    const plain = text.match(/(?<!\d)\d{6}(?!\d)/);
    return plain ? plain[0] : '';
  }

  /** Collect every string value from an arbitrary JSON payload (message text can be in any field). */
  function collectStrings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
    return out;
  }

  /** Call the SMS API once and return { otp, status }. Secret is only sent as a header. */
  async function fetchLatestOtp() {
    const deviceId = (settings.deviceId || '').trim();
    if (!deviceId) throw new Error('Device ID is empty');
    if (!settings.apiSecret) throw new Error('API secret not set (CONFIG tab)');

    const url = `${settings.apiUrl}?device_id=${encodeURIComponent(deviceId)}`;
    const res = await httpGet(url, { 'x-api-secret': settings.apiSecret, Accept: 'application/json' });
    if (res.status < 200 || res.status >= 300) throw new Error('SMS API HTTP ' + res.status);

    let texts;
    try {
      texts = collectStrings(JSON.parse(res.text));
    } catch (e) {
      texts = [res.text]; // plain-text response
    }
    // Age of the SMS (if the API gives received_at as epoch seconds/ms) - helps spot an old OTP.
    let ageSec = null;
    try {
      const data = JSON.parse(res.text);
      const ts = Number(data && (data.received_at || data.receivedAt || data.timestamp));
      if (Number.isFinite(ts) && ts > 0) ageSec = Math.round(Date.now() / 1000 - (ts > 1e12 ? ts / 1000 : ts));
    } catch (e) { /* plain-text response */ }

    for (const t of texts) {
      const otp = parseOtp(t);
      if (otp) return { otp, status: res.status, ageSec };
    }
    return { otp: '', status: res.status, ageSec };
  }

  /** CSS selector for the IVAC page's own OTP input (never the helper's input). */
  function pageOtpSelector() {
    return CONFIG.otpInput.split(',').map((s) => `${s.trim()}:not(#ivac-helper-panel *)`).join(',');
  }

  function findPageOtpInput() {
    try {
      return document.querySelector(pageOtpSelector());
    } catch (e) {
      return null;
    }
  }

  let otpTimer = null;
  let otpBusy = false;

  /** Fetch the OTP and fill the helper OTP field (+ the page's OTP field if it is already shown). Does NOT click Verify. */
  async function fetchAndFillOtp(source = 'manual') {
    if (otpBusy) return;
    otpBusy = true;
    try {
      addLog(`OTP fetch (${source}) for device "${settings.deviceId}"...`);
      setStatus('Fetching OTP...', 'warn');
      const { otp, ageSec } = await fetchLatestOtp();
      if (!otp) {
        addLog('No OTP found in the latest SMS. Enter it manually or press the OTP fetch button again.', 'warn');
        setStatus('No OTP found yet - enter manually or retry.', 'warn');
        return;
      }
      const helperOtp = document.getElementById('ivac-otp');
      if (helperOtp) helperOtp.value = otp;
      const pageOtp = findPageOtpInput();
      if (pageOtp) setReactInput(pageOtp, otp);
      addLog(`OTP filled (${otp.length} digits)${pageOtp ? ' in helper + page field' : ' in helper field'}. Press Verify.`);
      if (ageSec !== null && ageSec > 120) {
        addLog(`Note: the latest SMS is ${ageSec}s old - it may be a previous OTP. Use Resend OTP, then press the OTP fetch button again once the new SMS arrives.`, 'warn');
      }
      setStatus('OTP filled. Press Verify.', 'ok');
    } catch (err) {
      addLog('OTP fetch failed: ' + err.message, 'error');
      setStatus('OTP fetch failed: ' + err.message, 'error');
    } finally {
      otpBusy = false;
    }
  }

  /** After Login is clicked, wait N seconds (default 5) and then fetch the OTP once. */
  function scheduleOtpFetch() {
    clearTimeout(otpTimer);
    const sec = settings.otpDelaySec;
    addLog(`OTP will be fetched in ${sec}s.`);
    otpTimer = setTimeout(() => fetchAndFillOtp('auto'), sec * 1000);
  }

  // ==========================================================
  // FILES: 1 primary + 3 secondary PDFs, kept only in memory (never stored/uploaded by the helper)
  // ==========================================================
  const FILE_SLOTS = [
    { key: 'primary', label: 'Primary Applicant', clearLabel: 'Clear primary' },
    { key: 'sec1', label: 'Secondary 1', clearLabel: 'Clear secondary 1' },
    { key: 'sec2', label: 'Secondary 2', clearLabel: 'Clear secondary 2' },
    { key: 'sec3', label: 'Secondary 3', clearLabel: 'Clear secondary 3' },
  ];
  const slotFiles = {}; // key -> { file: File, status: string }

  const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

  function formatSize(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function renderSlot(key) {
    const nameEl = document.getElementById(`ivac-fslot-name-${key}`);
    const statEl = document.getElementById(`ivac-fslot-status-${key}`);
    if (!nameEl || !statEl) return;
    const s = slotFiles[key];
    nameEl.textContent = s ? s.file.name : 'No file selected';
    nameEl.title = s ? s.file.name : '';
    statEl.textContent = s ? s.status : '-';
    statEl.className = 'ivac-fslot-status' + (s ? (/^Applied/.test(s.status) ? ' ok' : /^(Not|Error|Skipped)/.test(s.status) ? ' err' : ' ready') : '');
  }

  function setSlotFile(key, file) {
    if (!file) return;
    if (!isPdf(file)) {
      delete slotFiles[key];
      renderSlot(key);
      addLog(`${key}: "${file.name}" is not a PDF - ignored.`, 'warn');
      setStatus('Only PDF files are accepted.', 'warn');
      return;
    }
    slotFiles[key] = { file, status: `Ready (${formatSize(file.size)})` };
    renderSlot(key);
    addLog(`File selected for ${key}: ${file.name} (${formatSize(file.size)})`);
  }

  function clearSlot(key) {
    delete slotFiles[key];
    const input = document.getElementById(`ivac-fslot-input-${key}`);
    if (input) input.value = '';
    renderSlot(key);
    addLog(`Cleared ${key}.`);
  }

  function clearAllSlots() {
    FILE_SLOTS.forEach((s) => {
      delete slotFiles[s.key];
      const input = document.getElementById(`ivac-fslot-input-${s.key}`);
      if (input) input.value = '';
      renderSlot(s.key);
    });
    addLog('Cleared all files.');
  }

  /** A file input that is actually rendered on the IVAC page (not ours, not disabled, not display:none). */
  function getPageFileInputs() {
    return [...document.querySelectorAll(CONFIG.fileInput)].filter((el) => {
      if (el.closest('#ivac-helper-panel') || el.disabled) return false;
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  function putFilesInInput(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Map selected PDFs onto the page's visible file inputs in order:
   * input #1 <- primary, input #2 <- secondary 1, #3 <- secondary 2, #4 <- secondary 3.
   * One single <input multiple> receives all selected files in that order.
   * Never submits the form.
   */
  function applyFiles() {
    const selected = FILE_SLOTS.filter((s) => slotFiles[s.key]);
    if (!selected.length) {
      setStatus('No files selected in the FILES tab.', 'warn');
      return 0;
    }
    const inputs = getPageFileInputs();
    if (!inputs.length) {
      addLog('APPLY FILES: no visible file input found on this page.', 'warn');
      setStatus('No file inputs visible on the page yet.', 'warn');
      return 0;
    }

    let applied = 0;
    if (inputs.length === 1 && inputs[0].multiple) {
      putFilesInInput(inputs[0], selected.map((s) => slotFiles[s.key].file));
      selected.forEach((s) => { slotFiles[s.key].status = 'Applied -> input #1 (multiple)'; renderSlot(s.key); });
      applied = selected.length;
      addLog(`APPLY FILES: ${applied} file(s) put into the single multiple-file input.`);
    } else {
      FILE_SLOTS.forEach((slot, idx) => {
        const entry = slotFiles[slot.key];
        if (!entry) return;
        const input = inputs[idx];
        if (!input) {
          entry.status = `Skipped - no input #${idx + 1} on page`;
          addLog(`APPLY FILES: ${slot.label} skipped (page has only ${inputs.length} file input(s)).`, 'warn');
        } else {
          putFilesInInput(input, [entry.file]);
          entry.status = `Applied -> input #${idx + 1}`;
          applied++;
          addLog(`APPLY FILES: ${slot.label} -> page file input #${idx + 1}.`);
        }
        renderSlot(slot.key);
      });
    }
    setStatus(`${applied} file(s) applied. Check the form, then submit yourself.`, applied ? 'ok' : 'warn');
    return applied;
  }

  function buildFilesPane(pane) {
    FILE_SLOTS.forEach((slot) => {
      const row = document.createElement('div');
      row.className = 'ivac-fslot';

      const head = document.createElement('div');
      head.className = 'ivac-fslot-head';
      const title = document.createElement('span');
      title.className = 'ivac-fslot-title';
      title.textContent = slot.label;
      const stat = document.createElement('span');
      stat.id = `ivac-fslot-status-${slot.key}`;
      stat.className = 'ivac-fslot-status';
      stat.textContent = '-';
      head.append(title, stat);

      const line = document.createElement('div');
      line.className = 'ivac-row';
      const pick = document.createElement('label');
      pick.className = 'ivac-btn ivac-btn-blue ivac-pick';
      pick.textContent = 'Choose PDF';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.id = `ivac-fslot-input-${slot.key}`;
      input.style.display = 'none';
      input.addEventListener('change', () => setSlotFile(slot.key, input.files && input.files[0]));
      pick.appendChild(input);
      const name = document.createElement('span');
      name.id = `ivac-fslot-name-${slot.key}`;
      name.className = 'ivac-fslot-name';
      name.textContent = 'No file selected';
      line.append(pick, name);

      row.append(head, line);
      pane.appendChild(row);
    });

    const clears = document.createElement('div');
    clears.className = 'ivac-grid2';
    FILE_SLOTS.forEach((slot) => {
      const b = document.createElement('button');
      b.className = 'ivac-btn ivac-btn-red';
      b.textContent = slot.clearLabel;
      b.addEventListener('click', () => clearSlot(slot.key));
      clears.appendChild(b);
    });
    pane.appendChild(clears);

    const all = document.createElement('button');
    all.className = 'ivac-btn ivac-btn-red ivac-full';
    all.textContent = 'Clear all';
    all.addEventListener('click', clearAllSlots);
    const apply = document.createElement('button');
    apply.className = 'ivac-btn ivac-btn-teal ivac-full';
    apply.id = 'ivac-btn-apply-files';
    apply.textContent = 'APPLY FILES';
    apply.addEventListener('click', applyFiles);
    const note = document.createElement('div');
    note.className = 'ivac-note';
    note.textContent = 'Files stay in this tab only (memory). Nothing is saved or submitted automatically.';
    pane.append(all, apply, note);
  }


  // ==========================================================
  // CONFIG: Update these selectors after inspecting the page.
  // ==========================================================
  const CONFIG = {
    phoneInput: 'input#phone, input#mobile, input[id*="phone"], input[id*="mobile"], input[name*="phone"], input[name*="mobile"], input[placeholder^="01"], input[placeholder*="01"]',
    passwordInput: 'input[type="password"], input[name*="password"], input[id*="password"]',
    otpInput: 'input[placeholder*="OTP"], input[name*="otp"], input[id*="otp"], input[maxlength="6"]',
    // Buttons are located by text when necessary; prefer CSS selectors when possible
    loginButton: 'button[type="submit"], input[type="submit"], button[id*="login"], button[class*="login"], a[id*="login"], a[class*="login"]',
    verifyButton: 'button[id*="verify"], button[class*="verify"]',
    fileInput: 'input[type="file"]',
    citySelect: 'select[name*="city"], select[name*="location"]',
    centerSelect: 'select[name*="center"], select[name*="office"]',
  };

  /**
   * Wait for an element to appear in the DOM.
   */
  async function waitForSelector(selector, timeout = 10000) {
    // If selector uses a non-standard :contains(...) token, delegate to waitForText
    const containsMatch = typeof selector === 'string' && selector.match(/:contains\((?:"|')?(.*?)(?:"|')?\)/i);
    if (containsMatch) {
      return waitForText(containsMatch[1], timeout);
    }

    try {
      const existing = document.querySelector(selector);
      if (existing) return existing;
    } catch (e) {
      // Invalid selector — fall back to a timeout-based failure
      return Promise.reject(new Error('Invalid selector: ' + selector));
    }

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        try {
          const el = document.querySelector(selector);
          if (el) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(el);
          }
        } catch (err) {
          // Swallow invalid-selector errors inside observer; they were handled above.
        }
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for selector: ${selector}`));
      }, timeout);

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        window.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, { childList: true, subtree: true });
        }, { once: true });
      }
    });
  }

  // Wait for an element that contains the provided text (case-insensitive).
  async function waitForText(textRegex, timeout = 10000, tagFilter = 'button,a,input') {
    const re = typeof textRegex === 'string' ? new RegExp(textRegex, 'i') : textRegex;
    const finder = () => {
      return Array.from(document.querySelectorAll(tagFilter)).find(el => re.test((el.textContent || el.value || '').trim()));
    };
    const existing = finder();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const el = finder();
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for text: ${textRegex}`));
      }, timeout);
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        window.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, { childList: true, subtree: true });
        }, { once: true });
      }
    });
  }

  // Find login button by visible text (robust against non-standard selectors)
  function findLoginButton() {
    return [...document.querySelectorAll('button,a,input')].find(button => {
      const text = (button.textContent || button.value || '').replace(/\s+/g, ' ').trim();
      return /sign in now|login|sign in/i.test(text);
    });
  }

  function waitForLoginButton(timeout = 15000, interval = 500) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const button = findLoginButton();
        if (button) {
          clearInterval(timer);
          resolve(button);
        } else if (Date.now() - started >= timeout) {
          clearInterval(timer);
          reject(new Error('Login button পাওয়া যায়নি'));
        }
      }, interval);
    });
  }

  /**
   * Fill a text/select input and trigger input/change events.
   */
  async function fillInput(selector, value) {
    const el = await waitForSelector(selector);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el;
  }

  /**
   * Click an element once it appears.
   */
  async function click(selector) {
    // If selector contains :contains("text"), extract the text and use waitForText fallback
    const containsMatch = selector && selector.match(/:contains\((?:"|')?(.*?)(?:"|')?\)/i);
    if (containsMatch) {
      const text = containsMatch[1];
      const el = await waitForText(text);
      await performNativeClick(el);
      return el;
    }

    try {
      const el = await waitForSelector(selector);
      await performNativeClick(el);
      return el;
    } catch (err) {
      // As a last resort, try to find by text if selector didn't work
      const textMatch = selector && selector.match(/(?:(?:"|')(.*?)(?:"|'))/);
      if (textMatch) {
        const el = await waitForText(textMatch[1]);
        el.click();
        return el;
      }
      throw err;
    }
  }

  // Perform a robust native-style click on an element.
  async function performNativeClick(el) {
    if (!el) throw new Error('Element not found for click');
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      // If disabled, try enabling temporarily
      if (el.disabled) el.disabled = false;
      // Ensure pointer events are allowed
      const prevPointer = el.style.pointerEvents;
      el.style.pointerEvents = 'auto';

      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const events = ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
      for (const type of events) {
        const ev = new MouseEvent(type, {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: Math.round(cx),
          clientY: Math.round(cy),
        });
        el.dispatchEvent(ev);
        await new Promise(r => setTimeout(r, 8));
      }

      // restore pointer-events
      el.style.pointerEvents = prevPointer || '';
    } catch (e) {
      // fallback: try to submit enclosing form or click via element.click()
      try {
        const form = el.closest && el.closest('form');
        if (form) {
          try { form.requestSubmit ? form.requestSubmit() : form.submit(); return; } catch (fs) {}
        }
      } catch (ignore) {}
      try { el.click(); } catch (err) { /* swallow */ }
      // Try clicking inner clickable children
      try {
        const inner = el.querySelector && (el.querySelector('button, a, [role="button"], span, div'));
        if (inner) {
          try { inner.click(); return; } catch (ie) {}
        }
      } catch (ignore) {}
      // Try ancestor anchor
      try {
        const anc = el.closest && (el.closest('a') || el.closest('[role="button"]'));
        if (anc) {
          try { anc.click(); return; } catch (ae) {}
        }
      } catch (ignore) {}
      throw e;
    }
  }

  // Expose the click helper for debugging from the console
  window.IVAC = window.IVAC || {};
  window.IVAC.performNativeClick = performNativeClick;

  // -------------------------
  // React-safe sign-in helpers
  // -------------------------

  let signInSubmitted = false;

  function setReactInput(input, value) {
    if (!input) return;

    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;

    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function findSignInButton() {
    return [...document.querySelectorAll('button')].find(button =>
      /sign in now|sign in|login/i.test(
        (button.textContent || '').replace(/\s+/g, ' ').trim()
      )
    );
  }

  function cloudflareCompleted() {
    const token = document.querySelector(
      'input[name="cf-turnstile-response"]'
    );

    return Boolean(token?.value?.trim());
  }

  function submitSignIn() {
    if (signInSubmitted) return;

    const button = findSignInButton();

    if (!button || button.disabled) return;

    signInSubmitted = true;

    const form = button.closest('form');

    if (form?.requestSubmit) {
      form.requestSubmit(button);
    } else {
      button.click();
    }

    console.log('✅ Sign In submitted');
    addLog('Sign In form submitted (after your Cloudflare check completed).');
  }

  function autoSignIn(mobile, password) {
    const NOT_HELPER = ':not(#ivac-helper-panel *)';
    const mobileInput =
      document.querySelector('input[type="tel"]' + NOT_HELPER) ||
      document.querySelector('input[name*="phone" i]' + NOT_HELPER) ||
      document.querySelector('input[name*="mobile" i]' + NOT_HELPER);

    const passwordInput =
      document.querySelector('input[type="password"]' + NOT_HELPER) ||
      document.querySelector('input[name*="pass" i]' + NOT_HELPER);

    if (!mobileInput || !passwordInput) {
      console.error('❌ Login inputs পাওয়া যায়নি');
      setStatus('Login inputs not found on page', 'error');
      return;
    }

    setReactInput(mobileInput, mobile);
    setReactInput(passwordInput, password);
    addLog('Login fields filled. Waiting for the Cloudflare check - complete it yourself; it is not bypassed.');

    const checker = setInterval(() => {
      if (cloudflareCompleted()) {
        clearInterval(checker);
        addLog('Cloudflare check completed.');

        // wait briefly for React state to settle
        setTimeout(submitSignIn, 500);
      }
    }, 500);

    // stop checking after 2 minutes
    setTimeout(() => {
      if (!signInSubmitted) addLog('Stopped waiting for Cloudflare after 2 minutes.', 'warn');
      clearInterval(checker);
    }, 120000);
  }

  // ==========================================================
  // UI Builder
  // ==========================================================
  const PANEL_CSS = `
    #ivac-helper-panel { position: fixed; top: 80px; left: 20px; width: 340px; max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px); display: flex; flex-direction: column; background: rgba(15,23,42,0.97);
      color: #e2e8f0; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
      z-index: 2147483000; overflow: hidden; border: 1px solid rgba(148,163,184,0.2); }
    #ivac-helper-panel * { box-sizing: border-box; }
    .ivac-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #0f172a;
      border-bottom: 1px solid rgba(148,163,184,0.15); cursor: move; touch-action: none; user-select: none; }
    .ivac-header-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: #fff; }
    .ivac-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
    .ivac-hbtns { display: flex; gap: 4px; }
    .ivac-close { background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; line-height: 1; padding: 0 4px; }
    .ivac-close:hover { color: #fff; }
    .ivac-tabbar { display: flex; background: #0b1220; border-bottom: 1px solid rgba(148,163,184,0.15); }
    .ivac-tab { flex: 1; padding: 7px 4px; background: transparent; border: none; border-bottom: 2px solid transparent;
      color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer; }
    .ivac-tab.active { color: #fff; border-bottom-color: #3b82f6; }
    .ivac-scroll { overflow: auto; min-height: 0; }
    .ivac-pane { display: none; padding: 10px; flex-direction: column; gap: 8px; }
    .ivac-pane.active { display: flex; }
    .ivac-row { display: flex; gap: 6px; align-items: center; }
    .ivac-field-label { font-size: 11px; color: #94a3b8; margin-bottom: -4px; }
    .ivac-input, .ivac-select, .ivac-file-label { flex: 1; min-width: 0; padding: 7px 9px; border-radius: 6px;
      border: 1px solid rgba(148,163,184,0.25); background: #1e293b; color: #e2e8f0; font-size: 13px; outline: none; }
    .ivac-input:focus, .ivac-select:focus { border-color: #3b82f6; }
    .ivac-input::placeholder { color: #94a3b8; }
    .ivac-btn { padding: 7px 10px; border-radius: 6px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff;
      transition: opacity 0.15s; white-space: nowrap; }
    .ivac-btn:hover { opacity: 0.9; }
    .ivac-btn-green { background: #22c55e; } .ivac-btn-blue { background: #3b82f6; } .ivac-btn-orange { background: #f97316; }
    .ivac-btn-red { background: #ef4444; } .ivac-btn-purple { background: #8b5cf6; } .ivac-btn-teal { background: #14b8a6; }
    .ivac-btn-gray { background: #475569; }
    .ivac-full { width: 100%; }
    .ivac-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ivac-file-wrap { display: flex; gap: 6px; align-items: center; }
    .ivac-file-label { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 7px 10px; font-size: 12px; }
    .ivac-file-list { font-size: 11px; color: #94a3b8; min-height: 16px; }
    .ivac-upload-btn { width: 100%; background: #14b8a6; }
    .ivac-note { font-size: 11px; color: #94a3b8; }
    .ivac-fslot { background: #111c33; border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; }
    .ivac-fslot-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
    .ivac-fslot-title { font-weight: 600; }
    .ivac-fslot-status { color: #94a3b8; font-size: 11px; text-align: right; }
    .ivac-fslot-status.ready { color: #facc15; } .ivac-fslot-status.ok { color: #22c55e; } .ivac-fslot-status.err { color: #f87171; }
    .ivac-fslot-name { font-size: 11px; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .ivac-pick { display: inline-block; }
    #ivac-helper-panel input, #ivac-helper-panel textarea, .ivac-log { -webkit-user-select: text !important; user-select: text !important; }
    .ivac-inwrap { display: flex; flex: 1; min-width: 0; gap: 3px; }
    .ivac-inwrap .ivac-input { flex: 1; }
    .ivac-paste { padding: 4px 6px; background: #475569; font-size: 13px; line-height: 1; }
    .ivac-log { height: 180px; overflow: auto; background: #0b1220; border-radius: 6px; padding: 6px; font: 11px ui-monospace, Menlo, Consolas, monospace; }
    .ivac-log-line { color: #cbd5e1; margin-bottom: 2px; word-break: break-word; }
    .ivac-log-line.warn { color: #facc15; } .ivac-log-line.error { color: #f87171; }
    .ivac-status { font-size: 11px; padding: 6px 10px; background: #1e293b; color: #22c55e; min-height: 28px; display: flex; align-items: center; gap: 6px;
      border-top: 1px solid rgba(148,163,184,0.15); }
    .ivac-status.warn { color: #facc15; } .ivac-status.error { color: #f87171; }
    .ivac-toggle { position: fixed; top: 80px; left: 20px; z-index: 2147482999; padding: 8px 12px; border-radius: 6px; background: #3b82f6;
      color: #fff; border: none; cursor: pointer; font-weight: 600; display: none; }
    #ivac-helper-panel.ivac-collapsed .ivac-tabbar, #ivac-helper-panel.ivac-collapsed .ivac-scroll,
    #ivac-helper-panel.ivac-collapsed .ivac-status { display: none; }
    @media (max-width: 480px) { #ivac-helper-panel { width: calc(100vw - 16px); left: 8px !important; } .ivac-grid2 { grid-template-columns: 1fr; } }
  `;

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'ivac-helper-panel';
    panel.innerHTML = `
      <div class="ivac-header" id="ivac-drag-handle">
        <div class="ivac-header-title">
          <span class="ivac-dot"></span>
          <span>Helper</span>
        </div>
        <div class="ivac-hbtns">
          <button class="ivac-close ivac-min" title="Minimize">&minus;</button>
          <button class="ivac-close ivac-hide" title="Hide">×</button>
        </div>
      </div>
      <div class="ivac-tabbar">
        <button class="ivac-tab active" data-tab="run">RUN</button>
        <button class="ivac-tab" data-tab="config">CONFIG</button>
        <button class="ivac-tab" data-tab="files">FILES</button>
        <button class="ivac-tab" data-tab="log">LOG</button>
      </div>
      <div class="ivac-scroll">
        <!-- ============ RUN ============ -->
        <div class="ivac-pane active" data-pane="run">
          <div class="ivac-field-label">Device ID</div>
          <input type="text" class="ivac-input" id="ivac-device-id" placeholder="Device ID" autocomplete="off" spellcheck="false">

          <div class="ivac-row">
            <input type="text" class="ivac-input" id="ivac-phone" placeholder="01XXXXXXXXX">
            <input type="text" class="ivac-input" id="ivac-password" placeholder="Enter password" autocomplete="off" spellcheck="false">
          </div>

          <div class="ivac-row">
            <button class="ivac-btn ivac-btn-green" id="ivac-btn-login">▶ Login</button>
            <input type="text" class="ivac-input" id="ivac-otp" placeholder="OTP (6 digit)">
            <button class="ivac-btn ivac-btn-gray" id="ivac-btn-fetch-otp" title="Fetch latest OTP now">⟳ OTP</button>
          </div>

          <div class="ivac-row">
            <button class="ivac-btn ivac-btn-blue" id="ivac-btn-verify">✔ Verify</button>
            <button class="ivac-btn ivac-btn-orange" id="ivac-btn-application">Application</button>
            <button class="ivac-btn ivac-btn-red" id="ivac-btn-reset">⟲ Reset</button>
            <input type="number" class="ivac-input" id="ivac-slot" value="1" min="1" max="10" style="max-width:50px">
          </div>

          <div class="ivac-file-wrap">
            <label class="ivac-file-label ivac-input">
              <input type="file" id="ivac-files" multiple style="display:none">
              Choose Files
            </label>
            <button class="ivac-btn ivac-btn-blue" id="ivac-btn-add">Add</button>
          </div>
          <div class="ivac-file-list" id="ivac-file-list">No files added yet.</div>

          <button class="ivac-btn ivac-upload-btn" id="ivac-btn-upload">⬆ Upload Selected</button>

          <div class="ivac-row">
            <select class="ivac-select" id="ivac-city">
              <option>Dhaka</option>
            </select>
            <select class="ivac-select" id="ivac-center">
              <option>IVAC, Dhaka (JFP)</option>
            </select>
          </div>

          <div class="ivac-row">
            <button class="ivac-btn ivac-btn-purple" id="ivac-btn-center">Select Center</button>
            <button class="ivac-btn ivac-btn-orange" id="ivac-btn-booking">Booking</button>
            <button class="ivac-btn ivac-btn-blue" id="ivac-btn-auto">Auto Date</button>
          </div>
        </div>

        <!-- ============ CONFIG ============ -->
        <div class="ivac-pane" data-pane="config">
          <div class="ivac-field-label">SMS API secret (visible; stored only in Tampermonkey storage)</div>
          <input type="text" class="ivac-input" id="ivac-api-secret" placeholder="x-api-secret" autocomplete="off" spellcheck="false">
          <div class="ivac-field-label">SMS API URL</div>
          <input type="text" class="ivac-input" id="ivac-api-url" spellcheck="false">
          <div class="ivac-field-label">Wait after Login before OTP fetch (seconds)</div>
          <input type="number" class="ivac-input" id="ivac-otp-delay" min="0" max="120" value="5">
          <button class="ivac-btn ivac-btn-green ivac-full" id="ivac-btn-save-config">Save settings</button>
          <div class="ivac-note">The OTP is fetched once after Login. Use ⟳ OTP in the RUN tab to retry. Cloudflare / CAPTCHA are never bypassed - you complete them yourself.</div>
        </div>

        <!-- ============ FILES (built in code) ============ -->
        <div class="ivac-pane" data-pane="files" id="ivac-files-pane"></div>

        <!-- ============ LOG ============ -->
        <div class="ivac-pane" data-pane="log">
          <div class="ivac-log" id="ivac-log"></div>
          <button class="ivac-btn ivac-btn-gray ivac-full" id="ivac-btn-clear-log">Clear log</button>
        </div>
      </div>
      <div class="ivac-status" id="ivac-status">
        <span>✅</span>
        <span>All reset successfully!</span>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    panel.appendChild(style);
    return panel;
  }

  function showTab(panel, name) {
    panel.querySelectorAll('.ivac-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panel.querySelectorAll('.ivac-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }

  /** Drag the panel by its header (mouse + touch). Position is remembered. */
  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - 40);
      panel.style.left = `${Math.min(maxLeft, Math.max(0, initialLeft + e.clientX - startX))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(0, initialTop + e.clientY - startY))}px`;
    });

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      store.set('panelPos', { left: parseInt(panel.style.left, 10) || 0, top: parseInt(panel.style.top, 10) || 0 });
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  async function restorePanelState(panel) {
    const pos = await store.get('panelPos', null);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      panel.style.left = `${Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 60))}px`;
      panel.style.top = `${Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 40))}px`;
    }
    if (await store.get('panelCollapsed', false)) panel.classList.add('ivac-collapsed');
  }

  function setStatus(text, type = 'ok') {
    addLog(text, type === 'warn' ? 'warn' : type === 'error' ? 'error' : 'info');
    const status = document.getElementById('ivac-status');
    if (!status) return;
    status.className = `ivac-status ${type === 'warn' ? 'warn' : type === 'error' ? 'error' : ''}`;
    const icon = type === 'ok' ? '✅' : type === 'warn' ? '⚠️' : '❌';
    status.innerHTML = `<span>${icon}</span><span></span>`;
    status.lastChild.textContent = text; // textContent: messages may contain page-derived text
  }

  // ==========================================================
  // Actions
  // ==========================================================
  async function doLogin() {
    // Deprecated: replaced by React-safe autoSignIn flow via helper button.
    console.warn('doLogin() is replaced by autoSignIn flow; call helper login button instead');
  }

  async function doVerify() {
    try {
      const otp = document.getElementById('ivac-otp').value;
      if (!otp) {
        setStatus('Enter OTP first.', 'warn');
        return;
      }
      setStatus('Filling OTP...', 'warn');
      const otpEl = await fillInput(pageOtpSelector(), otp);
      setReactInput(otpEl, otp);
      await click(CONFIG.verifyButton);
      setStatus('OTP submitted.', 'ok');
    } catch (err) {
      setStatus('Verify failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doApplication() {
    try {
      setStatus('Opening application section...', 'warn');
      // TODO: replace with the real selector for the application menu/button
      const appLink = Array.from(document.querySelectorAll('a, button')).find(el =>
        /application/i.test(el.textContent)
      );
      if (appLink) appLink.click();
      setStatus('Application action done.', 'ok');
    } catch (err) {
      setStatus('Application action failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  function doReset() {
    clearTimeout(otpTimer);
    document.getElementById('ivac-phone').value = '';
    document.getElementById('ivac-password').value = '';
    document.getElementById('ivac-otp').value = '';
    document.getElementById('ivac-file-list').textContent = 'No files added yet.';
    setStatus('All reset successfully!', 'ok');
  }

  function updateFileList() {
    const input = document.getElementById('ivac-files');
    const list = document.getElementById('ivac-file-list');
    if (input.files.length === 0) {
      list.textContent = 'No files added yet.';
      return;
    }
    const names = Array.from(input.files).map(f => f.name).join(', ');
    list.textContent = `${input.files.length} selected / total`;
    list.title = names;
    setStatus(`${input.files.length} file(s) ready.`, 'ok');
  }

  async function doAddFiles() {
    try {
      const fileInput = await waitForSelector(CONFIG.fileInput);
      const helperInput = document.getElementById('ivac-files');
      if (helperInput.files.length === 0) {
        setStatus('Choose files first.', 'warn');
        return;
      }
      // Transfer FileList to the real page input via DataTransfer
      const dt = new DataTransfer();
      Array.from(helperInput.files).forEach(f => dt.items.add(f));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      setStatus('Files attached to the page input.', 'ok');
    } catch (err) {
      setStatus('Add files failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doUpload() {
    try {
      setStatus('Uploading...', 'warn');
      // TODO: replace with the real upload button selector
      const uploadBtn = Array.from(document.querySelectorAll('button')).find(el =>
        /upload/i.test(el.textContent)
      );
      if (uploadBtn) uploadBtn.click();
      setStatus('Upload triggered.', 'ok');
    } catch (err) {
      setStatus('Upload failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doSelectCenter() {
    try {
      const city = document.getElementById('ivac-city').value;
      const center = document.getElementById('ivac-center').value;
      setStatus(`Selecting ${city} / ${center}...`, 'warn');
      await fillInput(CONFIG.citySelect, city);
      await fillInput(CONFIG.centerSelect, center);
      setStatus('Center selected.', 'ok');
    } catch (err) {
      setStatus('Select center failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doBooking() {
    try {
      setStatus('Starting booking...', 'warn');
      // TODO: replace with the real booking button selector
      const bookingBtn = Array.from(document.querySelectorAll('button')).find(el =>
        /booking|book now/i.test(el.textContent)
      );
      if (bookingBtn) bookingBtn.click();
      setStatus('Booking action done.', 'ok');
    } catch (err) {
      setStatus('Booking failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doAutoDate() {
    try {
      setStatus('Auto date: looking for first available slot...', 'warn');
      // TODO: replace with the real selector for available date/slot
      const firstSlot = document.querySelector('.available-date, .slot-available, [data-date]');
      if (firstSlot) {
        firstSlot.click();
        setStatus('First available date selected.', 'ok');
      } else {
        setStatus('No available date found. Refresh and try again.', 'warn');
      }
    } catch (err) {
      setStatus('Auto date failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  // ==========================================================
  // Copy / paste support
  // Some sites block paste/copy/right-click with page-level handlers. These capture-phase
  // listeners keep those handlers from seeing events that happen inside the helper panel
  // (the browser's own paste/copy still works). Each text field also gets a clipboard button.
  // ==========================================================
  function enableClipboardInPanel() {
    const inPanel = (e) => e.target && e.target.closest && e.target.closest('#ivac-helper-panel');
    ['paste', 'copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach((type) => {
      window.addEventListener(type, (e) => { if (inPanel(e)) e.stopImmediatePropagation(); }, true);
    });
    // Keyboard shortcuts (Ctrl+V/C/X/A) may be cancelled by the page; hide key events from it.
    // The OTP Enter shortcut is handled here because the element-level handler would not see it.
    ['keydown', 'keyup', 'keypress'].forEach((type) => {
      window.addEventListener(type, (e) => {
        if (!inPanel(e)) return;
        if (type === 'keydown' && e.key === 'Enter' && e.target.id === 'ivac-otp') {
          e.preventDefault();
          doVerify();
        }
        e.stopImmediatePropagation();
      }, true);
    });
  }

  /** Wrap a field with a small clipboard button that pastes the clipboard text into it. */
  function addPasteButton(id) {
    const input = document.getElementById(id);
    if (!input || input.parentElement.classList.contains('ivac-inwrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'ivac-inwrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ivac-btn ivac-paste';
    btn.title = 'Paste from clipboard';
    btn.textContent = '\u{1F4CB}';
    btn.addEventListener('click', async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
        addLog(`Pasted ${text.length} characters into ${id.replace('ivac-', '')}.`);
      } catch (err) {
        addLog('Clipboard button blocked by the browser - click the field and press Ctrl+V instead.', 'warn');
      }
    });
    wrap.appendChild(btn);
  }

  // ==========================================================
  // Initialize
  // ==========================================================
  async function init() {
    if (document.getElementById('ivac-helper-panel')) return;

    const panel = createPanel();
    document.body.appendChild(panel);
    buildFilesPane(document.getElementById('ivac-files-pane'));
    renderAllLogs();

    makeDraggable(panel, document.getElementById('ivac-drag-handle'));
    enableClipboardInPanel();
    ['ivac-device-id', 'ivac-phone', 'ivac-password', 'ivac-api-secret'].forEach(addPasteButton);

    // Tabs
    panel.querySelectorAll('.ivac-tab').forEach((t) => t.addEventListener('click', () => showTab(panel, t.dataset.tab)));

    // Minimize
    panel.querySelector('.ivac-min').addEventListener('click', () => {
      const collapsed = panel.classList.toggle('ivac-collapsed');
      store.set('panelCollapsed', collapsed);
    });

    // Hide (with a small "Helper" button to bring it back)
    panel.querySelector('.ivac-hide').addEventListener('click', () => {
      panel.style.display = 'none';
      if (!document.getElementById('ivac-helper-toggle')) {
        const toggle = document.createElement('button');
        toggle.id = 'ivac-helper-toggle';
        toggle.className = 'ivac-toggle';
        toggle.textContent = 'Helper';
        toggle.style.display = 'block';
        toggle.addEventListener('click', () => {
          panel.style.display = 'flex';
          toggle.remove();
        });
        document.body.appendChild(toggle);
      } else {
        document.getElementById('ivac-helper-toggle').style.display = 'block';
      }
    });

    // ---- Device ID (saved with GM_setValue, restored on reload) ----
    const deviceInput = document.getElementById('ivac-device-id');
    deviceInput.addEventListener('input', () => {
      settings.deviceId = deviceInput.value.trim();
      store.set('deviceId', settings.deviceId);
    });
    deviceInput.addEventListener('change', () => addLog(settings.deviceId ? `Device ID saved: ${settings.deviceId}` : 'Device ID cleared.'));

    // ---- CONFIG tab ----
    document.getElementById('ivac-btn-save-config').addEventListener('click', async () => {
      settings.apiSecret = document.getElementById('ivac-api-secret').value.trim();
      settings.apiUrl = document.getElementById('ivac-api-url').value.trim() || DEFAULT_OTP_API;
      const d = Number(document.getElementById('ivac-otp-delay').value);
      settings.otpDelaySec = Number.isFinite(d) && d >= 0 ? d : 5;
      await store.set('apiSecret', settings.apiSecret);
      await store.set('apiUrl', settings.apiUrl);
      await store.set('otpDelaySec', settings.otpDelaySec);
      setStatus('Settings saved.', 'ok');
    });

    document.getElementById('ivac-btn-clear-log').addEventListener('click', () => {
      logLines.length = 0;
      renderAllLogs();
    });

    // ---- RUN tab ----
    document.getElementById('ivac-btn-login').addEventListener('click', () => {
      // Reset submission flag and start React-safe auto sign in
      signInSubmitted = false;
      addLog('Login clicked.');
      const helperMobileInput = document.getElementById('ivac-phone');
      const helperPasswordInput = document.getElementById('ivac-password');
      autoSignIn(
        helperMobileInput.value.trim(),
        helperPasswordInput.value
      );
      // After 5 s (configurable) fetch the OTP SMS once and fill the OTP field.
      scheduleOtpFetch();
    });
    document.getElementById('ivac-btn-fetch-otp').addEventListener('click', () => fetchAndFillOtp('manual'));
    document.getElementById('ivac-btn-verify').addEventListener('click', doVerify);
    // Submit OTP by pressing Enter in the helper OTP input
    document.getElementById('ivac-otp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doVerify();
      }
    });
    document.getElementById('ivac-btn-application').addEventListener('click', doApplication);
    document.getElementById('ivac-btn-reset').addEventListener('click', doReset);
    document.getElementById('ivac-files').addEventListener('change', updateFileList);
    document.getElementById('ivac-btn-add').addEventListener('click', doAddFiles);
    document.getElementById('ivac-btn-upload').addEventListener('click', doUpload);
    document.getElementById('ivac-btn-center').addEventListener('click', doSelectCenter);
    document.getElementById('ivac-btn-booking').addEventListener('click', doBooking);
    document.getElementById('ivac-btn-auto').addEventListener('click', doAutoDate);

    // ---- Load saved settings into the UI ----
    await loadSettings();
    deviceInput.value = settings.deviceId;
    document.getElementById('ivac-api-secret').value = settings.apiSecret;
    document.getElementById('ivac-api-url').value = settings.apiUrl;
    document.getElementById('ivac-otp-delay').value = String(settings.otpDelaySec);
    await restorePanelState(panel);

    log('Helper panel injected on', window.location.href);
    addLog('Helper ready' + (settings.deviceId ? ` (Device ID: ${settings.deviceId})` : ' - set your Device ID.'));
    setStatus('Helper ready. Update CONFIG selectors if needed.', 'ok');
  }

  function startInit() {
    init().catch((err) => console.error('[IVAC Helper] init failed', err));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInit);
  } else {
    startInit();
  }

  // Expose helpers so you can test in the browser console.
  window.IVAC = Object.assign(window.IVAC || {}, {
    waitForSelector, fillInput, click, CONFIG, findLoginButton, waitForLoginButton,
    parseOtp, fetchLatestOtp, fetchAndFillOtp, applyFiles, addLog,
  });
})();
