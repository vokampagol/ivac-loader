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
    const num = async (key, def, min) => { const x = Number(await store.get(key, def)); return Number.isFinite(x) && x >= min ? x : def; };
    autoCfg.dwellSec = await num('dwellSec', 15, 1);
    autoCfg.maxMonths = await num('maxMonths', 3, 1);
    autoCfg.cyclePauseSec = await num('cyclePauseSec', 60, 5);
    autoCfg.maxCycles = await num('maxCycles', 10, 1);
    autoCfg.autoContinue = (await store.get('autoContinueV2', true)) !== false;
    autoCfg.preferCenter = String(await store.get('preferCenter', ''));
    autoCfg.startAt = String(await store.get('startAt', ''));
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
    updateFilesSummary();
  }

  function updateFilesSummary() {
    const el = document.getElementById('ivac-files-summary');
    if (!el) return;
    const n = FILE_SLOTS.filter((sl) => slotFiles[sl.key]).length;
    const done = FILE_SLOTS.filter((sl) => slotFiles[sl.key] && /^Applied/.test(slotFiles[sl.key].status)).length;
    el.className = 'ivac-files-summary' + (n ? ' ok' : '');
    el.textContent = !n
      ? 'Step 1: select your PDFs (all at once).'
      : done === n
        ? `\u2705 ${n} file(s) uploaded to the site.`
        : `\u2705 ${n} file(s) ready. Step 2: press START - they upload by themselves on the upload page.`;
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
    // --- easy mode: one picker (or drag & drop) for all PDFs, optional one-click START ---
    const multi = document.createElement('input');
    multi.type = 'file';
    multi.multiple = true;
    multi.accept = 'application/pdf,.pdf';
    multi.id = 'ivac-multi-files';
    multi.style.display = 'none';
    let startAfterPick = false;
    multi.addEventListener('change', () => {
      if (multi.files && multi.files.length && autoAssignFiles(multi.files) && (startAfterPick || document.getElementById('ivac-chk-autostart').checked)) autoStart('files selected');
      startAfterPick = false;
      multi.value = '';
    });
    const easy = document.createElement('div');
    easy.className = 'ivac-grid2';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'ivac-btn ivac-btn-blue';
    pickBtn.textContent = '\u{1F4C2} Select PDFs';
    pickBtn.addEventListener('click', () => { startAfterPick = false; multi.click(); });
    const pickStart = document.createElement('button');
    pickStart.className = 'ivac-btn ivac-btn-green';
    pickStart.id = 'ivac-btn-pick-start';
    pickStart.textContent = '\u25B6 Select PDFs & START';
    pickStart.addEventListener('click', () => { startAfterPick = true; multi.click(); });
    easy.append(pickBtn, pickStart);
    const drop = document.createElement('div');
    drop.className = 'ivac-drop';
    drop.textContent = 'or drop all PDFs here (file name with "primary" = primary applicant)';
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files.length && autoAssignFiles(e.dataTransfer.files) && document.getElementById('ivac-chk-autostart').checked) autoStart('files dropped');
    });
    const chk = document.createElement('label');
    chk.className = 'ivac-note';
    chk.innerHTML = '<input type="checkbox" id="ivac-chk-autostart"> Start automation right after files are selected';
    const summary = document.createElement('div');
    summary.id = 'ivac-files-summary';
    summary.className = 'ivac-files-summary';
    pane.append(summary, multi, easy, drop, chk);
    const adv = document.createElement('details');
    adv.className = 'ivac-adv';
    adv.innerHTML = '<summary>Change one file / clear / manual upload</summary>';
    chk.querySelector('input').checked = true;
    chk.querySelector('input').addEventListener('change', (e) => { try { store.set('autoStartOnPick', e.target.checked); } catch (err) { /* ignore */ } });
    Promise.resolve(store.get('autoStartOnPick', true)).then((v) => { chk.querySelector('input').checked = v !== false; }).catch(() => {});

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
      adv.appendChild(row);
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
    adv.appendChild(clears);

    const all = document.createElement('button');
    all.className = 'ivac-btn ivac-btn-red ivac-full';
    all.textContent = 'Clear all';
    all.addEventListener('click', clearAllSlots);
    const apply = document.createElement('button');
    apply.className = 'ivac-btn ivac-btn-teal ivac-full';
    apply.id = 'ivac-btn-apply-files';
    apply.textContent = 'APPLY FILES';
    apply.addEventListener('click', () => uploadSequence());
    const note = document.createElement('div');
    note.className = 'ivac-note';
    note.textContent = 'Files stay in this tab only (memory). Nothing is saved or submitted automatically.';
    adv.append(all, apply, note);
    pane.appendChild(adv);
    updateFilesSummary();
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
      const events = ['pointerover', 'pointerenter', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      for (const type of events) {
        const isPointer = type.startsWith('pointer');
        const Ctor = isPointer && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        const ev = new Ctor(type, {
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0,
          detail: type === 'click' ? 1 : 0,
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
    .ivac-files-summary { padding: 8px 10px; border-radius: 8px; background: #111c33; color: #facc15; font-size: 12px; font-weight: 600; }
    .ivac-files-summary.ok { color: #22c55e; }
    .ivac-adv > summary { cursor: pointer; font-size: 11px; color: #94a3b8; padding: 4px 0; }
    .ivac-adv { display: flex; flex-direction: column; gap: 6px; }
    .ivac-fslot { background: #111c33; border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; }
    .ivac-fslot-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
    .ivac-fslot-title { font-weight: 600; }
    .ivac-fslot-status { color: #94a3b8; font-size: 11px; text-align: right; }
    .ivac-fslot-status.ready { color: #facc15; } .ivac-fslot-status.ok { color: #22c55e; } .ivac-fslot-status.err { color: #f87171; }
    .ivac-fslot-name { font-size: 11px; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .ivac-pick { display: inline-block; }
    .ivac-ctrl { display: flex; gap: 6px; align-items: center; padding: 6px 10px; background: #0b1220; border-bottom: 1px solid rgba(148,163,184,0.15); }
    .ivac-ctrl .ivac-btn { padding: 6px 10px; }
    .ivac-btn:disabled { opacity: 0.4; cursor: default; }
    .ivac-auto-state { flex: 1; min-width: 0; font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    .ivac-drop { border: 1px dashed rgba(148,163,184,0.5); border-radius: 8px; padding: 10px; text-align: center; font-size: 12px; color: #94a3b8; }
    .ivac-drop.over { border-color: #3b82f6; color: #fff; background: rgba(59,130,246,0.12); }
    .ivac-log-line.good { color: #4ade80; font-weight: 600; }
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
    #ivac-helper-panel.ivac-collapsed .ivac-tabbar, #ivac-helper-panel.ivac-collapsed .ivac-scroll, #ivac-helper-panel.ivac-collapsed .ivac-ctrl,
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
      <div class="ivac-ctrl">
        <button class="ivac-btn ivac-btn-green" id="ivac-btn-start" title="Start the automatic booking steps">&#9654; START</button>
        <button class="ivac-btn ivac-btn-red" id="ivac-btn-stop" title="Stop automation" disabled>&#9632; STOP</button>
        <span class="ivac-auto-state" id="ivac-auto-state">Idle</span>
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

          <div class="ivac-note">Easy way: Login &rarr; FILES tab (choose files) &rarr; press START. Everything else is automatic.</div>
          <details class="ivac-note"><summary style="cursor:pointer">Manual tools (not needed for START)</summary>
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
          </details>
        </div>

        <!-- ============ CONFIG ============ -->
        <div class="ivac-pane" data-pane="config">
          <div class="ivac-field-label">SMS API secret (visible; stored only in Tampermonkey storage)</div>
          <input type="text" class="ivac-input" id="ivac-api-secret" placeholder="x-api-secret" autocomplete="off" spellcheck="false">
          <div class="ivac-field-label">SMS API URL</div>
          <input type="text" class="ivac-input" id="ivac-api-url" spellcheck="false">
          <div class="ivac-field-label">Wait after Login before OTP fetch (seconds)</div>
          <input type="number" class="ivac-input" id="ivac-otp-delay" min="0" max="120" value="5">
          <div class="ivac-field-label">Automation: wait on each date (seconds)</div>
          <input type="number" class="ivac-input" id="ivac-cfg-dwell" min="1" max="120" value="15">
          <div class="ivac-grid2">
            <div><div class="ivac-field-label">Months to scan</div><input type="number" class="ivac-input" id="ivac-cfg-months" min="1" max="12" value="3"></div>
            <div><div class="ivac-field-label">Rounds (max)</div><input type="number" class="ivac-input" id="ivac-cfg-cycles" min="1" max="100" value="10"></div>
          </div>
          <div class="ivac-field-label">Pause between rounds (seconds)</div>
          <input type="number" class="ivac-input" id="ivac-cfg-pause" min="5" max="3600" value="60">
          <div class="ivac-field-label">Preferred IVAC center (optional, e.g. "JFP"; empty = from your primary file's mission)</div>
          <input type="text" class="ivac-input" id="ivac-cfg-center" placeholder="auto" autocomplete="off" spellcheck="false">
          <div class="ivac-field-label">Start automation at (HH:MM, optional - e.g. 12:00 when booking opens)</div>
          <input type="text" class="ivac-input" id="ivac-cfg-startat" placeholder="now" maxlength="5" autocomplete="off">
          <label class="ivac-note"><input type="checkbox" id="ivac-cfg-autocontinue"> Auto-click "Continue Booking" when a slot is found (off = you click it)</label>
          <button class="ivac-btn ivac-btn-green ivac-full" id="ivac-btn-save-config">Save settings</button>
          <div class="ivac-note">The OTP is fetched once after Login. Use ⟳ OTP in the RUN tab to retry. Cloudflare / CAPTCHA are never bypassed - you complete them yourself.</div>
        </div>

        <!-- ============ FILES (built in code) ============ -->
        <div class="ivac-pane" data-pane="files" id="ivac-files-pane"></div>

        <!-- ============ LOG ============ -->
        <div class="ivac-pane" data-pane="log">
          <div class="ivac-log" id="ivac-log"></div>
          <div class="ivac-grid2">
            <button class="ivac-btn ivac-btn-gray" id="ivac-btn-inspect" title="Log the buttons, file inputs and calendar cells found on this page">Inspect page</button>
            <button class="ivac-btn ivac-btn-gray" id="ivac-btn-clear-log">Clear log</button>
          </div>
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
  // AUTOMATION (START / STOP)
  // Walks the normal booking pages for you:
  //   /signin -> /verify-login-phone-otp -> / -> /appointment/notice -> /appointment/file-upload
  //   -> /appointment/mission -> /appointment/time-slot (calendar scan)
  // Rules: Cloudflare is never bypassed (we wait until YOU/your browser pass it), every date is
  // given `dwellSec` seconds (default 15) before moving on, and it STOPS when a slot is found -
  // payment / final booking is left to you unless "auto-click Continue Booking" is ticked.
  // ==========================================================
  const SITE_HOME = 'https://appointment.ivacbd.com/';
  const autoCfg = { dwellSec: 15, maxMonths: 3, cyclePauseSec: 60, maxCycles: 10, autoContinue: true, preferCenter: '', startAt: '' };
  const auto = { running: false, busy: false, timer: null, lastPath: null, visits: {}, cycle: 0, homeJumps: 0, lastSave: 0, waitUntil: 0 };

  const MONTH_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i;
  const NO_SLOT_RE = /temporarily held|no (available )?slots?|slots? (is |are )?(not available|unavailable|full)|fully booked|sold out|no appointment|not available/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopped = () => !auto.running;

  /** Poll fn() until it returns something truthy (or timeout / abort). */
  async function waitFor(fn, timeout = 10000, interval = 300, abort = null) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (abort && abort()) return null;
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /** sleep that returns false early when automation is stopped. */
  async function sleepAbortable(ms, abort = stopped) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (abort()) return false;
      await sleep(Math.min(250, ms - (Date.now() - t0)));
    }
    return true;
  }

  const pagePath = () => (location.pathname.replace(/\/+$/, '') || '/').toLowerCase();
  const textOf = (el) => ((el.innerText || el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /** Disabled in the HTML sense OR visually faded (the site fades its buttons while Cloudflare verifies). */
  function isDisabledEl(el, { ignoreOpacity = false } = {}) {
    if (!el) return true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
    if (typeof el.className === 'string' && /\bdisabled\b/i.test(el.className)) return true;
    const cs = getComputedStyle(el);
    return cs.pointerEvents === 'none' || cs.cursor === 'not-allowed' || (!ignoreOpacity && parseFloat(cs.opacity) < 0.85);
  }

  /** First visible button/link whose text matches re (outside the helper panel). */
  function findClickable(re, { enabledOnly = true } = {}) {
    const els = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]');
    for (const el of els) {
      if (el.closest('#ivac-helper-panel') || !isVisible(el)) continue;
      if (!re.test(textOf(el))) continue;
      if (enabledOnly && isDisabledEl(el)) continue;
      return el;
    }
    // Fallback: the site often builds buttons from plain <div>/<span> with cursor:pointer.
    for (const el of document.querySelectorAll('div, span, p, li, label')) {
      if (el.closest('#ivac-helper-panel') || !isVisible(el)) continue;
      const t = textOf(el);
      if (!t || t.length > 60 || !re.test(t)) continue;
      let target = el;
      while (target && target !== document.body && getComputedStyle(target).cursor !== 'pointer') target = target.parentElement;
      if (!target || target === document.body) continue;
      if (enabledOnly && isDisabledEl(target)) continue;
      return target;
    }
    return null;
  }

  const cloudflareOkOrAbsent = () => {
    const inputs = [...document.querySelectorAll('input[name="cf-turnstile-response"]')];
    if (!inputs.length) return true;
    if (inputs.some((t) => t.value && t.value.trim())) return true;
    // Some pages keep an empty duplicate field: the visible widget saying "Success!" counts too.
    return [...document.querySelectorAll('div,span')].some((e) => !e.closest('#ivac-helper-panel') && e.children.length === 0 && /^success!?$/i.test(textOf(e)) && isVisible(e));
  };

  function setAutoState(text) {
    const el = document.getElementById('ivac-auto-state');
    if (el) { el.textContent = text; el.title = text; }
  }

  function updateAutoUi() {
    const start = document.getElementById('ivac-btn-start');
    const stop = document.getElementById('ivac-btn-stop');
    if (start) start.disabled = auto.running;
    if (stop) stop.disabled = !auto.running;
    if (!auto.running) setAutoState('Idle');
  }

  /** Click a matching button at most once per retryMs for this page visit. */
  async function clickStep(key, re, retryMs = 7000) {
    if (Date.now() - (auto.visits[key] || 0) < retryMs) return false;
    const el = findClickable(re);
    if (!el) {
      if (!auto.visits['nf_' + key]) {
        auto.visits['nf_' + key] = true;
        const cands = [...document.querySelectorAll('body *')].filter((e) => !e.closest('#ivac-helper-panel') && e.children.length < 4 && textOf(e).length < 60 && re.test(textOf(e)))
          .slice(0, 4).map((e) => { const cs = getComputedStyle(e); return `<${e.tagName.toLowerCase()}> cursor=${cs.cursor} opacity=${cs.opacity} visible=${isVisible(e)} disabled=${isDisabledEl(e)}`; });
        addLog(`Button ${re} not clickable yet. Candidates: ${cands.join(' | ') || 'none on page'}`, 'warn');
      }
      return false;
    }
    auto.visits[key] = Date.now();
    addLog(`Click: "${textOf(el).slice(0, 40)}"`);
    await performNativeClick(el);
    return true;
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.2, ctx.currentTime + t);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.18);
      });
    } catch (e) { /* audio blocked - ignore */ }
  }

  // ---------------- start / stop ----------------
  async function autoStart(source = 'button') {
    if (auto.running) return;
    auto.running = true;
    auto.cycle = 0;
    auto.homeJumps = 0;
    auto.lastPath = null;
    auto.visits = {};
    auto.waitUntil = 0;
    const m = /^(\d{1,2}):(\d{2})$/.exec(autoCfg.startAt || '');
    if (m) {
      const t = new Date();
      t.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (t.getTime() > Date.now()) { auto.waitUntil = t.getTime(); addLog(`Scheduled: automation waits until ${autoCfg.startAt}.`); }
    }
    await store.set('autoRun', true);
    await store.set('autoActive', Date.now());
    addLog(`AUTOMATION started (${source}).`);
    updateAutoUi();
    clearInterval(auto.timer);
    auto.timer = setInterval(tick, 1000);
    tick();
  }

  function autoStop(reason = 'stopped') {
    const was = auto.running;
    auto.running = false;
    clearInterval(auto.timer);
    store.set('autoRun', false);
    if (was) addLog(`AUTOMATION stopped: ${reason}.`);
    updateAutoUi();
  }

  async function tick() {
    if (!auto.running || auto.busy) return;
    if (auto.waitUntil && Date.now() < auto.waitUntil) {
      setAutoState(`starts at ${autoCfg.startAt} (in ${Math.ceil((auto.waitUntil - Date.now()) / 1000)}s)`);
      store.set('autoActive', Date.now());
      return;
    }
    auto.busy = true;
    try {
      const p = pagePath();
      if (p !== auto.lastPath) {
        auto.lastPath = p;
        auto.visits = {};
        addLog(`Page: ${p}`);
      }
      if (Date.now() - auto.lastSave > 10000) { auto.lastSave = Date.now(); store.set('autoActive', Date.now()); }
      await autoStep(p);
    } catch (err) {
      addLog('Automation error: ' + err.message, 'error');
      console.error(err);
    } finally {
      auto.busy = false;
    }
  }

  async function autoStep(p) {
    if (p === '/') return stepHome();
    if (p === '/signin') return stepSignin();
    if (p.startsWith('/verify')) return stepVerifyOtp();
    if (p === '/appointment/notice') return stepNotice();
    if (p === '/appointment/file-upload') return stepFileUpload();
    if (p === '/appointment/mission') return stepMission();
    if (p === '/appointment/time-slot') return stepTimeSlot();
    return stepUnknown(p);
  }

  // ---------------- step handlers ----------------
  function navigateHome(why) {
    auto.homeJumps++;
    addLog(`Opening the IVAC start page (${why}).`);
    store.set('autoRun', true);
    store.set('autoActive', Date.now());
    location.assign(SITE_HOME);
  }

  function stepUnknown(p) {
    const v = auto.visits;
    setAutoState(`unknown page ${p}`);
    if (!v.since) { v.since = Date.now(); addLog(`Not a known booking page (${p}).`, 'warn'); }
    if (Date.now() - v.since < 10000) return;
    if (auto.homeJumps >= 2) { autoStop('stuck on an unknown page'); return; }
    navigateHome('unknown page');
  }

  async function stepHome() {
    setAutoState('home');
    if (await clickStep('take', /take your appointment/i)) return;
    // Not logged in: the "Sign In" button leads to the login page.
    if (!findClickable(/take your appointment/i)) await clickStep('signin', /^sign in$/i);
  }

  async function stepSignin() {
    const v = auto.visits;
    setAutoState('sign in');
    const phone = document.getElementById('ivac-phone').value.trim();
    const pass = document.getElementById('ivac-password').value;
    if (!phone || !pass) {
      if (!v.warned) { v.warned = true; addLog('Sign-in page: fill phone + password in the RUN tab, automation continues by itself.', 'warn'); }
      return;
    }
    if (v.loginClicked) return;
    v.loginClicked = true;
    document.getElementById('ivac-btn-login').click(); // same path as pressing Login: fills fields, waits for Cloudflare, schedules the OTP fetch
  }

  async function stepVerifyOtp() {
    const v = auto.visits;
    setAutoState('OTP page');
    if (!v.since) v.since = Date.now();
    const helperOtp = document.getElementById('ivac-otp');
    if (!helperOtp.value && !otpBusy && Date.now() - v.since > settings.otpDelaySec * 1000 && !v.fetched) {
      v.fetched = true;
      await fetchAndFillOtp('auto');
    }
    const otp = helperOtp.value.trim();
    if (otp.length !== OTP_LENGTH) return;
    const pageOtp = findPageOtpInput();
    if (pageOtp && pageOtp.value !== otp) setReactInput(pageOtp, otp);
    if (!cloudflareOkOrAbsent()) { setAutoState('waiting for Cloudflare check'); return; }
    await clickStep('verify', /verify|submit|login/i, 8000).catch(() => {});
  }

  async function stepNotice() {
    setAutoState('notice page');
    await clickStep('next', /next step/i, 6000);
  }

  async function stepFileUpload() {
    const v = auto.visits;
    const queued = FILE_SLOTS.some((s) => slotFiles[s.key]);
    if (!v.uploadDone) {
      if (!queued) {
        setAutoState('waiting for PDF files');
        if (!v.noFiles) { v.noFiles = true; addLog('File-upload page: choose your PDFs in the FILES tab (Select PDFs & START).', 'warn'); }
        return;
      }
      setAutoState('uploading files');
      const ok = await uploadSequence({ abort: stopped });
      if (!auto.running) return;
      if (!ok) {
        v.fail = (v.fail || 0) + 1;
        if (v.fail >= 3) { autoStop('file upload failed 3 times'); return; }
        await sleep(2000);
        return;
      }
      v.uploadDone = true;
    }
    if (await clickStep('save', /save\s*(&|and)\s*continue/i, 5000)) return;
    if (findClickable(/save\s*(&|and)\s*continue/i)) return;
    if (!cloudflareOkOrAbsent()) { setAutoState('waiting for Cloudflare check'); return; }
    setAutoState('confirming applicants');
    await clickStep('confirm', /confirm all information/i, 6000);
  }

  /**
   * Pick the IVAC center. The site fills the mission from the primary web file (e.g. "Rajshahi");
   * we match the center list against that mission. A preferred center from CONFIG wins when set.
   * Returns the index in `texts`, or -1 when it would be a guess.
   */
  function chooseCenter(texts, mission, prefer) {
    const low = texts.map((t) => t.toLowerCase());
    const p = (prefer || '').trim().toLowerCase();
    if (p) {
      const i = low.findIndex((t) => t.includes(p));
      if (i !== -1) return i;
    }
    if (texts.length === 1) return 0;
    const m = (mission || '').split('-').pop().trim().toLowerCase();
    if (m) {
      const hits = low.map((t, i) => (t.includes(m) ? i : -1)).filter((i) => i !== -1);
      if (hits.length === 1) return hits[0];
    }
    return -1;
  }

  async function stepMission() {
    const v = auto.visits;
    setAutoState('mission / center');
    const body = textOf(document.body);
    const mm = body.match(/Select a mission\s+(.+?)\s+Select your IVAC center/i);
    const mission = mm ? mm[1].trim() : '';
    if (mission && !/loading/i.test(mission) && !v.missionLogged) { v.missionLogged = true; addLog(`Mission from your primary file: ${mission}`); }
    const unselected = /Select your IVAC center\s*Select IVAC center/i.test(body);
    if (unselected) {
      // Open the center list once, then choose the center that belongs to the mission.
      if (!v.opened) {
        const trigger = [...document.querySelectorAll('div,button,span')].find((e) => !e.closest('#ivac-helper-panel') && e.children.length === 0 && /^Select IVAC center$/i.test(textOf(e)));
        if (trigger) { v.opened = true; addLog('Opening the IVAC center list.'); await performNativeClick(trigger.closest('button,[role="button"],div') || trigger); await sleep(600); }
      }
      const seen = new Set();
      const options = [...document.querySelectorAll('div,li,button,span')].filter((e) => {
        if (e.closest('#ivac-helper-panel') || e.children.length || !/^IVAC,/i.test(textOf(e)) || !isVisible(e)) return false;
        const t = textOf(e).toLowerCase();
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });
      if (!options.length || v.picked) return;
      const idx = chooseCenter(options.map(textOf), mission, autoCfg.preferCenter);
      if (idx !== -1) {
        v.picked = true;
        addLog(`Selecting center: ${textOf(options[idx])}${mission ? ` (mission ${mission})` : ''}.`);
        await performNativeClick(options[idx]);
        await sleep(600);
      } else if (!v.multi) {
        v.multi = true;
        addLog('Several IVAC centers match - choose yours manually (or set "Preferred center" in CONFIG); automation continues afterwards.', 'warn');
      }
      return;
    }
    await clickStep('mission', /confirm mission/i, 6000);
  }

  // ---------------- file upload (one file at a time, waits for the applicant counter) ----------------
  const applicantCount = () => {
    const m = textOf(document.body).match(/Total number of applicants:\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  };

  /** Every <input type=file> of the page, hidden ones included (the site hides the real input behind a drop-zone). */
  function getAllFileInputs() {
    return [...document.querySelectorAll(CONFIG.fileInput)].filter((el) => !el.closest('#ivac-helper-panel') && !el.disabled);
  }

  /**
   * Upload the selected PDFs in order: primary first, then secondary 1..3.
   * After every file we wait until "Total number of applicants" goes up. Never submits anything.
   */
  async function uploadSequence(opts = {}) {
    const abort = opts.abort || (() => false);
    const queue = FILE_SLOTS.filter((s) => slotFiles[s.key]);
    if (!queue.length) { setStatus('No files selected in the FILES tab.', 'warn'); return false; }

    for (let qi = 0; qi < queue.length; qi++) {
      if (abort()) return false;
      const slot = queue[qi];
      const entry = slotFiles[slot.key];
      const before = applicantCount();
      if (before !== null && before > qi) {
        entry.status = 'Applied (already on page)';
        renderSlot(slot.key);
        addLog(`${slot.label}: already uploaded (${before} applicant(s) on page).`);
        continue;
      }
      const input = await waitFor(() => {
        const all = getAllFileInputs();
        return all[qi] || all[all.length - 1] || null;
      }, 15000, 300, abort);
      if (!input && !/file-upload/.test(location.pathname) && !opts.abort) {
        entry.status = `Ready (${formatSize(entry.file.size)})`;
        renderSlot(slot.key);
        setStatus('Files are ready. They upload automatically when START reaches the upload page.', 'warn');
        addLog('Not on the upload page yet - files stay ready; press START and they upload automatically.');
        return false;
      }
      if (!input) {
        entry.status = 'Error - no file input on page';
        renderSlot(slot.key);
        addLog(`${slot.label}: no file input found on this page.`, 'warn');
        setStatus('No file input found on the page.', 'warn');
        return false;
      }
      entry.status = 'Uploading...';
      renderSlot(slot.key);
      addLog(`Uploading ${slot.label}: ${entry.file.name}`);
      putFilesInInput(input, [entry.file]);

      let confirmed = false;
      const t0 = Date.now();
      // A page that never shows an applicant counter cannot confirm anything: do not wait the full 20 s.
      const maxWait = before === null ? 12000 : 40000;
      while (Date.now() - t0 < maxWait) {
        if (abort()) return false;
        const c = applicantCount();
        if (c !== null && c > qi) { confirmed = true; break; }
        await sleep(400);
      }
      if (!confirmed && applicantCount() === null) {
        // The page shows no counter at all: give the upload a moment and carry on.
        await sleep(2500);
        confirmed = true;
        addLog(`${slot.label}: page shows no applicant counter - assuming upload accepted.`, 'warn');
      }
      if (!confirmed) {
        entry.status = 'Error - not accepted by the page';
        renderSlot(slot.key);
        addLog(`${slot.label}: the page did not add the applicant within 40 s (check size <= 500KB, PDF only).`, 'error');
        setStatus(`${slot.label}: upload not accepted.`, 'error');
        return false;
      }
      entry.status = 'Applied';
      renderSlot(slot.key);
      await sleep(800);
    }
    setStatus('All files uploaded. Check the page, then continue.', 'ok');
    return true;
  }

  /**
   * One picker for everything: file whose name contains "primary" -> primary, the others (A-Z) -> secondary 1..3.
   * Without "primary" in any name the first file is the primary.
   */
  function autoAssignFiles(fileList) {
    const files = [...fileList].filter(isPdf);
    const skipped = fileList.length - files.length;
    if (skipped) addLog(`${skipped} non-PDF file(s) ignored.`, 'warn');
    if (!files.length) { setStatus('No PDF selected.', 'warn'); return false; }
    let primary = files.find((f) => /primary/i.test(f.name)) || files[0];
    const others = files.filter((f) => f !== primary).sort((a, b) => a.name.localeCompare(b.name));
    if (others.length > 3) addLog(`Only 3 secondary files are supported - ignoring ${others.length - 3}.`, 'warn');
    clearAllSlots();
    setSlotFile('primary', primary);
    others.slice(0, 3).forEach((f, i) => setSlotFile(`sec${i + 1}`, f));
    return true;
  }

  // ---------------- calendar (/appointment/time-slot) ----------------
  function alphaOf(c) {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]) : 1;
  }

  /** Circle outline or filled background = the site's "bookable" styling. */
  function hasPaint(el) {
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const border = bw >= 1 && cs.borderTopStyle !== 'none' && alphaOf(cs.borderTopColor) > 0.1;
    return border || alphaOf(cs.backgroundColor) > 0.05;
  }

  function findMonthLabel() {
    const els = document.querySelectorAll('div,span,p,h1,h2,h3,h4,button');
    for (const e of els) {
      if (e.closest('#ivac-helper-panel') || e.children.length) continue;
      const t = (e.textContent || '').trim();
      if (t.length < 25 && MONTH_RE.test(t) && isVisible(e)) return e;
    }
    return null;
  }

  function dayCellsIn(root) {
    const out = [];
    const seen = new Set();
    root.querySelectorAll('*').forEach((leaf) => {
      if (leaf.children.length) return;
      const t = (leaf.textContent || '').trim();
      if (!/^\d{1,2}$/.test(t)) return;
      const n = Number(t);
      if (n < 1 || n > 31 || !isVisible(leaf)) return;
      const el = leaf.closest('button,[role="gridcell"],[role="button"],td') || leaf;
      if (seen.has(el)) return;
      seen.add(el);
      out.push({ n, el, leaf });
    });
    return out;
  }

  function getCalendar() {
    const label = findMonthLabel();
    if (!label) return null;
    let root = label.parentElement;
    while (root && root !== document.body) {
      const days = dayCellsIn(root);
      if (days.length >= 28) return { root, label, days };
      root = root.parentElement;
    }
    return null;
  }

  /** Elements that make up the "circle" around a day number: the cell, its number and small wrappers. */
  function circleChain(cell) {
    const chain = [];
    let e = cell.leaf;
    while (e && chain.length < 4) {
      const r = e.getBoundingClientRect();
      if (r.width > 90 || r.height > 90) break;
      chain.push(e);
      if (e === cell.el) { if (e.parentElement) chain.push(e.parentElement); break; }
      e = e.parentElement;
    }
    return chain.filter((x) => {
      const r = x.getBoundingClientRect();
      return r.width <= 90 && r.height <= 90;
    });
  }

  /** Only dates that have the circle/filled styling and are not disabled. Plain grey numbers are skipped. */
  function isAvailableDay(cell) {
    const chain = circleChain(cell);
    if (!chain.length) return false;
    for (const x of chain) {
      if (x.disabled || x.getAttribute('aria-disabled') === 'true') return false;
      if (/disabled|unavailable|past|outside/i.test(typeof x.className === 'string' ? x.className : '')) return false;
      const cs = getComputedStyle(x);
      if (cs.pointerEvents === 'none' || cs.cursor === 'not-allowed') return false;
    }
    return chain.some(hasPaint);
  }

  function isSelectedCell(cell) {
    return circleChain(cell).some((x) => x.getAttribute('aria-selected') === 'true' || /selected|active/i.test(typeof x.className === 'string' ? x.className : ''));
  }

  function monthNavButton(cal, dir) {
    const lr = cal.label.getBoundingClientRect();
    const cx = lr.left + lr.width / 2;
    const cy = lr.top + lr.height / 2;
    const ARROW = /^[‹›<>«»←→❮❯⟨⟩]$/;
    const seen = new Set();
    const cands = [];
    cal.root.querySelectorAll('button,[role="button"],a,span,div').forEach((e) => {
      const isArrow = e.children.length === 0 && ARROW.test((e.textContent || '').trim());
      const isBtn = e.matches('button,[role="button"],a');
      if (!isArrow && !isBtn) return;
      const target = e.closest('button,[role="button"],a') || e;
      if (seen.has(target) || cal.days.some((d) => d.el === target || target.contains(d.leaf))) return;
      const r = target.getBoundingClientRect();
      if (!r.width || Math.abs(r.top + r.height / 2 - cy) > 40) return;
      seen.add(target);
      cands.push({ target, x: r.left + r.width / 2 });
    });
    const side = cands.filter((c) => (dir > 0 ? c.x > cx : c.x < cx)).sort((a, b) => (dir > 0 ? a.x - b.x : b.x - a.x));
    return side.length ? side[0].target : null;
  }

  /** Click the month arrow and wait until the month label changes. Returns false when impossible. */
  async function changeMonth(dir) {
    const cal = getCalendar();
    if (!cal) return false;
    const btn = monthNavButton(cal, dir);
    if (!btn || isDisabledEl(btn, { ignoreOpacity: true })) return false;
    const before = cal.label.textContent.trim();
    await performNativeClick(btn);
    const changed = await waitFor(() => {
      const c = getCalendar();
      return c && c.label.textContent.trim() !== before ? c : null;
    }, 5000, 250, stopped);
    return Boolean(changed);
  }

  const noSlotNodes = () => [...document.querySelectorAll('div,p,span,li,[role="alert"],[role="status"]')].filter((e) => {
    if (e.closest('#ivac-helper-panel')) return false;
    const t = textOf(e);
    return t.length > 0 && t.length < 250 && NO_SLOT_RE.test(t);
  });

  const continueBookingBtn = () => findClickable(/continue booking/i, { enabledOnly: false });

  /** Select one circled date and give the site `dwellSec` seconds to show a slot. */
  async function tryDate(n, monthText) {
    const cal = getCalendar();
    const cell = cal && cal.days.find((d) => d.n === n);
    if (!cell || !isAvailableDay(cell)) return 'skip';
    const pre = new Set(noSlotNodes());
    const wasSelected = isSelectedCell(cell);
    if (!wasSelected) await performNativeClick(cell.el);
    setAutoState(`date ${n} (${monthText})`);
    const dwell = Math.max(1, autoCfg.dwellSec);
    addLog(`Checking ${monthText} - date ${n}: waiting up to ${dwell}s for a slot...`);
    const t0 = Date.now();
    let negSeen = wasSelected && pre.size > 0;
    let okSince = null;
    let everReady = false;
    let clicked = false;
    auto.visits.contClicked = false;
    const startPath = location.pathname;
    while (Date.now() - t0 < dwell * 1000) {
      if (!auto.running) return 'stopped';
      if (noSlotNodes().some((x) => !pre.has(x))) negSeen = true;
      const btn = continueBookingBtn();
      const ready = btn && !isDisabledEl(btn, { ignoreOpacity: true }) && cloudflareOkOrAbsent();
      if (ready) everReady = true;
      // Press Continue Booking as soon as the site enables it (then give the page a moment to move on).
      if (ready && autoCfg.autoContinue && !clicked && Date.now() - t0 > 800) {
        clicked = true;
        auto.visits.contClicked = true;
        addLog(`Continue Booking is enabled on ${monthText} - date ${n}: clicking it.`);
        await performNativeClick(btn);
      }
      if (clicked && location.pathname !== startPath) return 'slot'; // the click took us to the next booking page
      // Ignore the first moments after the click (page still loading); scale with the wait time.
      const warmUp = Math.min(2500, dwell * 300);
      const sustain = Math.min(1500, dwell * 150);
      if (ready && !negSeen && Date.now() - t0 > warmUp) {
        okSince = okSince || Date.now();
        if (Date.now() - okSince >= sustain) return 'slot';
      } else {
        okSince = null;
      }
      await sleep(400);
    }
    const b = continueBookingBtn();
    addLog(`No slot on ${monthText} - date ${n}${negSeen ? ' (site says slots are taken)' : ` (Continue Booking: ${b ? (isDisabledEl(b, { ignoreOpacity: true }) ? `disabled by site${b.disabled ? ' (disabled attribute)' : ''}` : 'enabled') : 'not found'}, Cloudflare: ${cloudflareOkOrAbsent() ? 'ok' : 'not done'}, ever ready: ${everReady})`}.`);
    return 'none';
  }

  /** Scan circled dates month after month. Returns 'slot' | 'exhausted' | 'stopped' | 'nocal'. */
  /** After a month change the site re-renders/animates the cells: wait until the circled dates stop changing. */
  async function settleCalendar() {
    let last = null;
    for (let i = 0; i < 12 && !stopped(); i++) {
      const c = getCalendar();
      const sig = c ? c.days.filter(isAvailableDay).map((d) => d.n).sort((a, b) => a - b).join(',') : '';
      if (sig && sig === last) break;
      last = sig;
      await sleep(300);
    }
  }

  async function scanCalendar() {
    for (; auto.cycle < autoCfg.maxCycles && auto.running; auto.cycle++) {
      addLog(`Calendar scan - round ${auto.cycle + 1}/${autoCfg.maxCycles}`);
      let moved = 0;
      for (let m = 0; m < autoCfg.maxMonths && auto.running; m++) {
        const cal = await waitFor(getCalendar, 15000, 500, stopped);
        if (!cal) { addLog('Calendar not found on the page.', 'warn'); return auto.running ? 'nocal' : 'stopped'; }
        await settleCalendar();
        const monthText = cal.label.textContent.trim();
        const days = (getCalendar() || cal).days.filter(isAvailableDay).map((d) => d.n).sort((a, b) => a - b);
        addLog(`${monthText}: circled dates = ${days.length ? days.join(', ') : 'none'}`);
        for (const n of days) {
          const res = await tryDate(n, monthText);
          if (res === 'slot') return { result: 'slot', n, monthText };
          if (res === 'stopped') return 'stopped';
        }
        if (m < autoCfg.maxMonths - 1) {
          addLog(`Month finished - going to the next month.`);
          if (!(await changeMonth(+1))) { addLog('No next month available.'); break; }
          moved++;
        }
      }
      for (let k = 0; k < moved && auto.running; k++) await changeMonth(-1);
      if (auto.cycle < autoCfg.maxCycles - 1 && auto.running) {
        addLog(`No slot yet. Next round in ${autoCfg.cyclePauseSec}s.`);
        setAutoState(`next round in ${autoCfg.cyclePauseSec}s`);
        await sleepAbortable(autoCfg.cyclePauseSec * 1000);
      }
    }
    return auto.running ? 'exhausted' : 'stopped';
  }

  async function stepTimeSlot() {
    const v = auto.visits;
    if (v.scanning) return;
    v.scanning = true;
    setAutoState('calendar scan');
    const res = await scanCalendar();
    if (res && res.result === 'slot') {
      addLog(`SLOT AVAILABLE: ${res.monthText} - date ${res.n}. Complete Continue Booking now!`);
      setStatus(`SLOT FOUND: ${res.monthText} date ${res.n}`, 'ok');
      document.title = '✅ SLOT FOUND - ' + document.title.replace(/^✅ SLOT FOUND - /, '');
      beep();
      if (autoCfg.autoContinue && auto.visits.contClicked) {
        addLog('Continue Booking was already clicked for this date.');
      } else if (autoCfg.autoContinue) {
        const btn = continueBookingBtn();
        if (btn && !isDisabledEl(btn)) { addLog('Auto-clicking Continue Booking (enabled in CONFIG).'); await performNativeClick(btn); }
      } else {
        addLog('Continue Booking is left to you (CONFIG: "Auto-click Continue Booking" is off).');
      }
      autoStop('slot found');
    } else if (res === 'exhausted') {
      autoStop('no slot found in all rounds');
    } else if (res === 'nocal') {
      v.scanning = false;
      await sleep(3000);
    }
  }

  // ---------------- page inspector (for tuning selectors) ----------------
  function inspectPage() {
    addLog(`INSPECT ${location.pathname}`);
    const btns = [...document.querySelectorAll('button,a,[role="button"]')].filter((e) => !e.closest('#ivac-helper-panel') && isVisible(e)).slice(0, 25);
    addLog('Buttons: ' + (btns.map((b) => `"${textOf(b).slice(0, 28)}"${isDisabledEl(b) ? '(off)' : ''}`).join(', ') || 'none'));
    addLog(`File inputs: ${getAllFileInputs().length} (visible: ${getAllFileInputs().filter(isVisible).length})`);
    const cal = getCalendar();
    if (cal) {
      addLog(`Calendar: ${cal.label.textContent.trim()}, cells=${cal.days.length}, circled=${cal.days.filter(isAvailableDay).map((d) => d.n).join(',') || 'none'}`);
      const sample = cal.days.slice(0, 3).concat(cal.days.filter(isAvailableDay).slice(0, 2));
      sample.forEach((d) => {
        const cs = getComputedStyle(d.el);
        addLog(`  day ${d.n}: <${d.el.tagName.toLowerCase()} class="${String(d.el.className).slice(0, 40)}"> border=${cs.borderTopWidth} ${cs.borderTopColor} bg=${cs.backgroundColor} avail=${isAvailableDay(d)}`);
      });
      addLog(`Month arrows: prev=${monthNavButton(cal, -1) ? 'yes' : 'no'}, next=${monthNavButton(cal, +1) ? 'yes' : 'no'}`);
    }
    addLog(`No-slot messages: ${noSlotNodes().length}, Continue Booking: ${continueBookingBtn() ? (isDisabledEl(continueBookingBtn()) ? 'disabled' : 'enabled') : 'absent'}`);
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
      const readNum = (id, def, min) => { const x = Number(document.getElementById(id).value); return Number.isFinite(x) && x >= min ? x : def; };
      autoCfg.dwellSec = readNum('ivac-cfg-dwell', 15, 1);
      autoCfg.maxMonths = readNum('ivac-cfg-months', 3, 1);
      autoCfg.cyclePauseSec = readNum('ivac-cfg-pause', 60, 5);
      autoCfg.maxCycles = readNum('ivac-cfg-cycles', 10, 1);
      autoCfg.autoContinue = document.getElementById('ivac-cfg-autocontinue').checked;
      autoCfg.preferCenter = document.getElementById('ivac-cfg-center').value.trim();
      autoCfg.startAt = document.getElementById('ivac-cfg-startat').value.trim();
      for (const k of ['dwellSec', 'maxMonths', 'cyclePauseSec', 'maxCycles', 'preferCenter', 'startAt']) await store.set(k, autoCfg[k]);
      await store.set('autoContinueV2', autoCfg.autoContinue);
      setStatus('Settings saved.', 'ok');
    });

    document.getElementById('ivac-btn-start').addEventListener('click', () => autoStart('START button'));
    document.getElementById('ivac-btn-stop').addEventListener('click', () => autoStop('STOP pressed'));
    document.getElementById('ivac-btn-inspect').addEventListener('click', inspectPage);
    document.getElementById('ivac-btn-clear-log').addEventListener('click', () => {
      logLines.length = 0;
      renderAllLogs();
    });

    // ---- RUN tab ----
    document.getElementById('ivac-btn-login').addEventListener('click', () => {
      // Reset submission flag and start React-safe auto sign in
      signInSubmitted = false;
      addLog('Login clicked.');
      document.getElementById('ivac-otp').value = ''; // a new login sends a new OTP - never reuse the old one
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
    document.getElementById('ivac-cfg-dwell').value = String(autoCfg.dwellSec);
    document.getElementById('ivac-cfg-months').value = String(autoCfg.maxMonths);
    document.getElementById('ivac-cfg-pause').value = String(autoCfg.cyclePauseSec);
    document.getElementById('ivac-cfg-cycles').value = String(autoCfg.maxCycles);
    document.getElementById('ivac-cfg-autocontinue').checked = autoCfg.autoContinue;
    document.getElementById('ivac-cfg-center').value = autoCfg.preferCenter;
    document.getElementById('ivac-cfg-startat').value = autoCfg.startAt;
    await restorePanelState(panel);

    log('Helper panel injected on', window.location.href);
    addLog('Helper ready' + (settings.deviceId ? ` (Device ID: ${settings.deviceId})` : ' - set your Device ID.'));
    setStatus('Helper ready. Update CONFIG selectors if needed.', 'ok');

    // Resume after a page reload/redirect, but only if automation was active in the last 3 minutes.
    const wasRunning = await store.get('autoRun', false);
    const lastActive = Number(await store.get('autoActive', 0));
    if (wasRunning && Date.now() - lastActive < 180000) autoStart('resume after reload');
    else if (wasRunning) store.set('autoRun', false);
  }

  // Show page errors in the LOG with their source file: tells whether the site or this script threw.
  window.addEventListener('error', (e) => {
    const src = e.filename ? ` @ ${String(e.filename).split('/').slice(-1)[0]}:${e.lineno}` : '';
    addLog(`Page error: ${e.message}${src}`, 'warn');
    const b = document.getElementById('ivac-loader-badge');
    if (b && /PAGE ERROR/.test(b.textContent)) b.remove(); // the site's own errors are not a loader failure
  });

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
    findClickable, autoStart, autoStop, uploadSequence, autoAssignFiles, getCalendar, isAvailableDay, inspectPage,
  });
})();
