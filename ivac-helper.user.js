// ==UserScript==
// @name         IVAC Helper (Phase 1)
// @namespace    https://github.com/vokampagol/ivac-loader
// @version      0.1
// @description  Compact draggable IVAC helper panel (Phase 1). UI only, no automation.
// @author       Copilot
// @match        https://appointment.ivacbd.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Phase 1: Build a compact draggable floating panel with tabs and progress steps.
  // Uses GM_setValue / GM_getValue to persist panel position and collapsed state.

  const STORAGE_KEYS = {
    posX: 'ivac_helper_pos_x',
    posY: 'ivac_helper_pos_y',
    collapsed: 'ivac_helper_collapsed',
    closed: 'ivac_helper_closed'
  };

  // Minimal CSS: dark professional theme, responsive layout.
  GM_addStyle(`
  #ivac-helper-panel {
    position: fixed;
    left: 8px;
    top: 80px;
    width: 320px;
    max-width: calc(100% - 16px);
    background: #0f1720;
    color: #e6eef6;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(2,6,23,0.6);
    z-index: 9999999;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
    display: flex;
    flex-direction: column;
    user-select: none;
  }
  #ivac-helper-header { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move; }
  #ivac-helper-title { font-weight:600; font-size:14px; letter-spacing:0.6px; }
  #ivac-helper-controls { margin-left:auto; display:flex; gap:6px; }
  .ivac-btn { background:transparent; border: none; color: #cbd8e6; padding:6px; border-radius:6px; cursor:pointer }
  .ivac-btn:hover { background: rgba(255,255,255,0.03); }
  .ivac-tabbar { display:flex; gap:6px; padding:6px; border-top:1px solid rgba(255,255,255,0.02); border-bottom:1px solid rgba(255,255,255,0.02); }
  .ivac-tab { flex:1; text-align:center; padding:8px 6px; font-size:13px; cursor:pointer; color:#9fb1c9 }
  .ivac-tab.active { background: linear-gradient(90deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); color:#e6eef6; border-radius:6px }
  .ivac-body { padding:10px; font-size:13px; }
  .ivac-progress { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:6px 0 }
  .ivac-step { flex:1; text-align:center; font-size:11px; color:#8096ac }
  .ivac-step.current { color:#fff; font-weight:600 }
  .ivac-small { font-size:11px; color:#9fb1c9 }
  @media (max-width:420px) {
    #ivac-helper-panel { width: 92%; left:4%; top:60px; }
    #ivac-helper-title { font-size:13px }
  }
`);

  // Create the panel DOM once.
  function createPanel() {
    if (document.getElementById('ivac-helper-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ivac-helper-panel';

    // Header
    const header = document.createElement('div'); header.id = 'ivac-helper-header';
    const title = document.createElement('div'); title.id = 'ivac-helper-title'; title.textContent = 'IVAC HELPER';
    const controls = document.createElement('div'); controls.id = 'ivac-helper-controls';

    const btnMin = document.createElement('button'); btnMin.className = 'ivac-btn'; btnMin.title = 'Minimize'; btnMin.innerHTML = '&#8722;';
    const btnClose = document.createElement('button'); btnClose.className = 'ivac-btn'; btnClose.title = 'Close'; btnClose.innerHTML = '&#10005;';

    controls.appendChild(btnMin); controls.appendChild(btnClose);
    header.appendChild(title); header.appendChild(controls);

    // Tab bar
    const tabbar = document.createElement('div'); tabbar.className = 'ivac-tabbar';
    const tabs = ['RUN','CONFIG','FILES','LOG'].map(t => { const el = document.createElement('div'); el.className='ivac-tab'; el.textContent=t; el.dataset.tab=t.toLowerCase(); return el; });
    tabs.forEach(t => tabbar.appendChild(t));

    // Body
    const body = document.createElement('div'); body.className = 'ivac-body'; body.id = 'ivac-helper-body';

    // Progress steps
    const progress = document.createElement('div'); progress.className = 'ivac-progress';
    const steps = ['Login','OTP','Files','Center','Date','Payment'];
    steps.forEach((s, idx) => {
      const st = document.createElement('div'); st.className='ivac-step'; st.textContent=s; if (idx===0) st.classList.add('current'); progress.appendChild(st);
    });

    // Tab containers (simple placeholders for Phase 1)
    const tabContainers = document.createElement('div'); tabContainers.id='ivac-tab-containers';
    const runTab = createTabContent('run', 'Run panel placeholder. Booking automation is not implemented in Phase 1.');
    const cfgTab = createTabContent('config', 'Settings will appear here in Phase 2.');
    const filesTab = createTabContent('files', 'File helper will appear in Phase 3.');
    const logTab = createTabContent('log', 'Log messages will appear here.');
    tabContainers.appendChild(runTab); tabContainers.appendChild(cfgTab); tabContainers.appendChild(filesTab); tabContainers.appendChild(logTab);

    body.appendChild(progress); body.appendChild(tabContainers);

    panel.appendChild(header); panel.appendChild(tabbar); panel.appendChild(body);
    document.body.appendChild(panel);

    // Wire up interactions
    makeDraggable(panel, header);
    restorePanelPosition(panel);

    // Tab switching
    tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    showTab('run');

    // Minimize/close buttons
    btnMin.addEventListener('click', () => toggleCollapsed());
    btnClose.addEventListener('click', () => closePanel());
  }

  function createTabContent(id, text) {
    const c = document.createElement('div'); c.className='ivac-tab-content'; c.dataset.id=id; c.style.display='none';
    const p = document.createElement('div'); p.className='ivac-small'; p.textContent = text;
    c.appendChild(p);
    return c;
  }

  function showTab(id) {
    const all = document.querySelectorAll('.ivac-tab'); all.forEach(t => t.classList.toggle('active', t.dataset.tab===id));
    const contents = document.querySelectorAll('.ivac-tab-content'); contents.forEach(c => c.style.display = (c.dataset.id===id ? 'block' : 'none'));
  }

  function toggleCollapsed() {
    const panel = document.getElementById('ivac-helper-panel');
    const collapsed = GM_getValue(STORAGE_KEYS.collapsed, false);
    if (!collapsed) {
      // collapse: hide body & tabbar
      const body = panel.querySelector('.ivac-body'); const tabbar = panel.querySelector('.ivac-tabbar');
      body.style.display='none'; tabbar.style.display='none';
      GM_setValue(STORAGE_KEYS.collapsed, true);
    } else {
      const body = panel.querySelector('.ivac-body'); const tabbar = panel.querySelector('.ivac-tabbar');
      body.style.display=''; tabbar.style.display='';
      GM_setValue(STORAGE_KEYS.collapsed, false);
    }
  }

  function closePanel() {
    const panel = document.getElementById('ivac-helper-panel');
    if (!panel) return;
    panel.style.display='none';
    GM_setValue(STORAGE_KEYS.closed, true);
  }

  // Restore saved position and collapsed state
  function restorePanelPosition(panel) {
    const closed = GM_getValue(STORAGE_KEYS.closed, false);
    if (closed) { panel.style.display='none'; return; }
    const collapsed = GM_getValue(STORAGE_KEYS.collapsed, false);
    if (collapsed) {
      panel.querySelector('.ivac-body').style.display='none';
      panel.querySelector('.ivac-tabbar').style.display='none';
    }
    const x = GM_getValue(STORAGE_KEYS.posX, null);
    const y = GM_getValue(STORAGE_KEYS.posY, null);
    if (x !== null && y !== null) {
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    }
  }

  // Make element draggable by header. Saves position on drag end.
  function makeDraggable(panel, handle) {
    let isDragging = false; let startX=0, startY=0, origX=0, origY=0;
    handle.addEventListener('pointerdown', (e) => {
      isDragging = true; handle.setPointerCapture(e.pointerId);
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect(); origX = rect.left; origY = rect.top;
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX; const dy = e.clientY - startY;
      let nx = Math.max(4, origX + dx); let ny = Math.max(4, origY + dy);
      // keep within viewport bounds (simple)
      nx = Math.min(window.innerWidth - panel.offsetWidth - 4, nx);
      ny = Math.min(window.innerHeight - panel.offsetHeight - 4, ny);
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    window.addEventListener('pointerup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      // save position
      try { GM_setValue(STORAGE_KEYS.posX, parseInt(panel.style.left,10)); GM_setValue(STORAGE_KEYS.posY, parseInt(panel.style.top,10)); } catch (err) { console.warn('GM_setValue failed', err); }
    });
  }

  // Initialize and attach panel when DOM is ready.
  function init() {
    try { createPanel(); } catch (err) { console.error('IVAC Helper failed to create panel', err); }
  }

  // Attempt to initialize after a short delay to allow SPA frameworks to attach; also watch for page changes later.
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
    setTimeout(init, 1200);
  } else {
    setTimeout(init, 400);
  }

  // Expose a lightweight logger to the panel's LOG tab for future phases.
  window.__ivacHelper = window.__ivacHelper || {};
  window.__ivacHelper.log = function (msg) {
    const logTab = document.querySelector('.ivac-tab-content[data-id="log"]');
    if (!logTab) return;
    const d = document.createElement('div'); d.className='ivac-small'; d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logTab.appendChild(d);
  };

})();
