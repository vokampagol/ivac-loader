(function () {
  'use strict';

  const log = (...args) => console.log('[IVAC Helper]', ...args);

  // ==========================================================
  // CONFIG: Update these selectors after inspecting the page.
  // ==========================================================
  const CONFIG = {
    phoneInput: 'input[placeholder*="phone"], input[name*="phone"], input[name*="mobile"], input[type="tel"]',
    passwordInput: 'input[type="password"], input[name*="password"]',
    otpInput: 'input[placeholder*="OTP"], input[name*="otp"], input[maxlength="6"]',
    loginButton: 'button[type="submit"], button:contains("Login")',
    verifyButton: 'button:contains("Verify")',
    fileInput: 'input[type="file"]',
    citySelect: 'select[name*="city"], select[name*="location"]',
    centerSelect: 'select[name*="center"], select[name*="office"]',
  };

  /**
   * Wait for an element to appear in the DOM.
   */
  async function waitForSelector(selector, timeout = 10000) {
    const existing = document.querySelector(selector);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
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
    const el = await waitForSelector(selector);
    el.click();
    return el;
  }

  // ==========================================================
  // UI Builder
  // ==========================================================
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'ivac-helper-panel';
    panel.innerHTML = `
      <style>
        #ivac-helper-panel {
          position: fixed;
          top: 80px;
          left: 20px;
          width: 320px;
          background: rgba(15, 23, 42, 0.96);
          color: #e2e8f0;
          border-radius: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.4);
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          z-index: 999999;
          overflow: hidden;
          border: 1px solid rgba(148, 163, 184, 0.2);
        }
        #ivac-helper-panel * {
          box-sizing: border-box;
        }
        .ivac-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          background: #0f172a;
          border-bottom: 1px solid rgba(148, 163, 184, 0.15);
          cursor: move;
        }
        .ivac-header-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          font-size: 14px;
          color: #fff;
        }
        .ivac-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
        }
        .ivac-close {
          background: transparent;
          border: none;
          color: #94a3b8;
          font-size: 18px;
          cursor: pointer;
          line-height: 1;
        }
        .ivac-close:hover { color: #fff; }
        .ivac-body {
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .ivac-row {
          display: flex;
          gap: 8px;
        }
        .ivac-input, .ivac-select, .ivac-file-label {
          flex: 1;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid rgba(148, 163, 184, 0.25);
          background: #1e293b;
          color: #e2e8f0;
          font-size: 13px;
          outline: none;
        }
        .ivac-input:focus, .ivac-select:focus {
          border-color: #3b82f6;
        }
        .ivac-input::placeholder { color: #94a3b8; }
        .ivac-btn {
          padding: 8px 12px;
          border-radius: 6px;
          border: none;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          color: #fff;
          transition: opacity 0.15s;
        }
        .ivac-btn:hover { opacity: 0.9; }
        .ivac-btn-green { background: #22c55e; }
        .ivac-btn-blue { background: #3b82f6; }
        .ivac-btn-orange { background: #f97316; }
        .ivac-btn-red { background: #ef4444; }
        .ivac-btn-purple { background: #8b5cf6; }
        .ivac-btn-teal { background: #14b8a6; }
        .ivac-file-wrap {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .ivac-file-label {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 7px 10px;
          font-size: 12px;
        }
        .ivac-file-list {
          font-size: 11px;
          color: #94a3b8;
          min-height: 18px;
        }
        .ivac-upload-btn {
          width: 100%;
          background: #14b8a6;
        }
        .ivac-status {
          font-size: 11px;
          padding: 6px 8px;
          border-radius: 6px;
          background: #1e293b;
          color: #22c55e;
          min-height: 28px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .ivac-status.warn { color: #facc15; }
        .ivac-status.error { color: #f87171; }
        .ivac-toggle {
          position: fixed;
          top: 80px;
          left: 20px;
          z-index: 999998;
          padding: 8px 12px;
          border-radius: 6px;
          background: #3b82f6;
          color: #fff;
          border: none;
          cursor: pointer;
          font-weight: 600;
          display: none;
        }
      </style>
      <div class="ivac-header" id="ivac-drag-handle">
        <div class="ivac-header-title">
          <span class="ivac-dot"></span>
          <span>Helper</span>
        </div>
        <button class="ivac-close" title="Hide">×</button>
      </div>
      <div class="ivac-body">
        <div class="ivac-row">
          <input type="text" class="ivac-input" id="ivac-phone" placeholder="01XXXXXXXXX">
          <input type="password" class="ivac-input" id="ivac-password" placeholder="Enter password">
        </div>

        <div class="ivac-row">
          <button class="ivac-btn ivac-btn-green" id="ivac-btn-login">▶ Login</button>
          <input type="text" class="ivac-input" id="ivac-otp" placeholder="OTP (6 digit)">
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

        <div class="ivac-status" id="ivac-status">
          <span>✅</span>
          <span>All reset successfully!</span>
        </div>
      </div>
    `;
    return panel;
  }

  function makeDraggable(panel, handle) {
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      panel.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${Math.max(0, initialLeft + dx)}px`;
      panel.style.top = `${Math.max(0, initialTop + dy)}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      panel.style.cursor = '';
    });
  }

  function setStatus(text, type = 'ok') {
    const status = document.getElementById('ivac-status');
    if (!status) return;
    status.className = `ivac-status ${type === 'warn' ? 'warn' : type === 'error' ? 'error' : ''}`;
    const icon = type === 'ok' ? '✅' : type === 'warn' ? '⚠️' : '❌';
    status.innerHTML = `<span>${icon}</span><span>${text}</span>`;
  }

  // ==========================================================
  // Actions
  // ==========================================================
  async function doLogin() {
    try {
      const phone = document.getElementById('ivac-phone').value;
      const password = document.getElementById('ivac-password').value;
      if (!phone || !password) {
        setStatus('Phone and password required.', 'warn');
        return;
      }
      setStatus('Filling login fields...', 'warn');
      await fillInput(CONFIG.phoneInput, phone);
      await fillInput(CONFIG.passwordInput, password);
      await click(CONFIG.loginButton);
      setStatus('Login submitted. Check for OTP.', 'ok');
    } catch (err) {
      setStatus('Login failed: ' + err.message, 'error');
      console.error(err);
    }
  }

  async function doVerify() {
    try {
      const otp = document.getElementById('ivac-otp').value;
      if (!otp) {
        setStatus('Enter OTP first.', 'warn');
        return;
      }
      setStatus('Filling OTP...', 'warn');
      await fillInput(CONFIG.otpInput, otp);
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
  // Initialize
  // ==========================================================
  function init() {
    if (document.getElementById('ivac-helper-panel')) return;

    const panel = createPanel();
    document.body.appendChild(panel);

    makeDraggable(panel, document.getElementById('ivac-drag-handle'));

    document.querySelector('#ivac-helper-panel .ivac-close').addEventListener('click', () => {
      panel.style.display = 'none';
      if (!document.getElementById('ivac-helper-toggle')) {
        const toggle = document.createElement('button');
        toggle.id = 'ivac-helper-toggle';
        toggle.className = 'ivac-toggle';
        toggle.textContent = 'Helper';
        toggle.style.display = 'block';
        toggle.addEventListener('click', () => {
          panel.style.display = 'block';
          toggle.remove();
        });
        document.body.appendChild(toggle);
      } else {
        document.getElementById('ivac-helper-toggle').style.display = 'block';
      }
    });

    document.getElementById('ivac-btn-login').addEventListener('click', doLogin);
    document.getElementById('ivac-btn-verify').addEventListener('click', doVerify);
    document.getElementById('ivac-btn-application').addEventListener('click', doApplication);
    document.getElementById('ivac-btn-reset').addEventListener('click', doReset);
    document.getElementById('ivac-files').addEventListener('change', updateFileList);
    document.getElementById('ivac-btn-add').addEventListener('click', doAddFiles);
    document.getElementById('ivac-btn-upload').addEventListener('click', doUpload);
    document.getElementById('ivac-btn-center').addEventListener('click', doSelectCenter);
    document.getElementById('ivac-btn-booking').addEventListener('click', doBooking);
    document.getElementById('ivac-btn-auto').addEventListener('click', doAutoDate);

    log('Helper panel injected on', window.location.href);
    setStatus('Helper ready. Update CONFIG selectors if needed.', 'ok');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose helpers so you can test in the browser console.
  window.IVAC = { waitForSelector, fillInput, click, CONFIG };
})();
