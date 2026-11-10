// ============================================================
// BulkAI Google Flow Bridge - Content Script for Google Flow
// Handles prompt injection, generation monitoring, and image extraction
// Supports: flow.google.com & labs.google/fx/tools/flow
// ============================================================

(() => {
  'use strict';

  // ─── Guard & Cleanup on re-injection ──────────────────────────────
  if (window.__bulkaiFlowCleanup) {
    try { window.__bulkaiFlowCleanup(); } catch (_) {}
  }

  const INSTANCE_ID = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  window.__bulkaiFlowActiveInstance = INSTANCE_ID;
  window.__bulkaiFlowCsInitialized = true;

  const GENERATION_TIMEOUT = 300000; // 5 minutes max per prompt
  const POLL_INTERVAL = 2000; // Check every 2 seconds
  const SETTLE_DELAY = 3000; // Wait 3s after all tiles complete

  let isProcessing = false;
  let currentPromptId = null;
  let processingStartTime = 0;

  window.__bulkaiFlowCleanup = () => {
    isProcessing = false;
    currentPromptId = null;
    processingStartTime = 0;
  };

  // ─── DOM Selectors ───────────────────────────────────────────

  const SELECTORS = {
    // Prompt editors (ProseMirror, textareas, contenteditable, role textbox)
    promptEditor: [
      '#PINHOLE_TEXT_AREA_ELEMENT_ID',
      '[data-slate-editor="true"][contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'flow-rich-text-editor div.ProseMirror',
      'flow-rich-text-editor [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
      'input[type="text"]:not([type="hidden"])'
    ],
    // Explicit Generate / Submit button selectors (Strict action labels only)
    generateButton: [
      'button.generate-button',
      'button[aria-label="Generate"]',
      'button[aria-label="Create"]',
      'button[aria-label="Submit"]',
      'button[aria-label="Send"]',
      'button[aria-label="Run"]',
      'button[aria-label*="generation" i]',
      'button[aria-label*="generate" i]',
      'button[aria-label*="create" i]',
      'button[aria-label*="run" i]',
      'button[aria-label*="submit" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="tạo" i]',
      'button[aria-label*="gửi" i]',
      'button[type="submit"]',
      '[role="button"][aria-label*="generate" i]',
      '[role="button"][aria-label*="create" i]',
      '[role="button"][aria-label*="run" i]',
      '[role="button"][aria-label*="submit" i]',
      '[role="button"][aria-label*="send" i]',
      '[role="button"][aria-label*="tạo" i]',
      '[role="button"][aria-label*="gửi" i]'
    ],
    // Pending tiles (generation in progress)
    pendingTile: [
      'flow-pending-tile',
      '[data-status="generating"]',
      '[data-status="pending"]',
      '.pending-tile',
      '.tile-loading',
      'flow-tile[loading]',
      '.flow-spinner',
      'mat-progress-spinner',
      'mat-spinner'
    ],
    // Image tiles (completed)
    imageTile: [
      'flow-image-tile',
      '[data-tile]',
      '.image-tile',
      'flow-tile'
    ],
    // Completed images inside tiles
    tileImage: [
      'flow-image-tile img',
      '[data-tile] img',
      '.image-tile img',
      'flow-tile img',
      'flow-tile-container img'
    ],
    // Tile containers
    tileContainer: 'flow-tile-container',
    // Clear prompt button
    clearButton: 'button.clear-button, button[aria-label="Clear prompt"], button[aria-label*="clear" i], button[aria-label*="xóa" i]'
  };

  // ─── Utilities ───────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function querySelector(selectorList) {
    if (typeof selectorList === 'string') {
      return document.querySelector(selectorList);
    }
    for (const sel of selectorList) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function isClickable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList.contains('disabled')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (style.pointerEvents === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function describeButton(btn) {
    if (!btn) return 'null';
    const tag = btn.tagName.toLowerCase();
    const cls = btn.className ? '.' + String(btn.className).split(' ')[0] : '';
    const label = btn.getAttribute('aria-label') || '';
    const txt = (btn.textContent || '').trim().substring(0, 15);
    const rect = btn.getBoundingClientRect();
    return `${tag}${cls} [label="${label}"] [text="${txt}"] (x=${Math.round(rect.right)}, y=${Math.round(rect.top)})`;
  }

  function clickElement(el) {
    if (!el) return;
    el.focus();
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function log(msg, type = 'info') {
    const prefix = '[BulkAI Flow]';
    if (type === 'error') console.error(prefix, msg);
    else if (type === 'warning') console.warn(prefix, msg);
    else console.log(prefix, msg);
  }

  function sendToBackground(data) {
    try {
      chrome.runtime.sendMessage(data, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch(e) { /* extension context invalidated */ }
  }

  function getProseMirrorView(editor) {
    try {
      if (editor.pmViewDesc && editor.pmViewDesc.view) return editor.pmViewDesc.view;
      if (editor.pmViewDesc && editor.pmViewDesc.pmView) return editor.pmViewDesc.pmView;
      if (editor.pmView) return editor.pmView;
      if (editor.__pmView) return editor.__pmView;
      let p = editor.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        if (p.pmViewDesc && p.pmViewDesc.view) return p.pmViewDesc.view;
        if (p.pmView) return p.pmView;
        if (p._view) return p._view;
        p = p.parentElement;
      }
    } catch (_) {}
    return null;
  }

  // ─── Prompt Injection ────────────────────────────────────────

  async function clearPromptEditor(editor) {
    // 1. Try clear button
    try {
      const clearBtn = document.querySelector(SELECTORS.clearButton);
      if (clearBtn && isClickable(clearBtn)) {
        clickElement(clearBtn);
        await sleep(300);
        return;
      }
    } catch (_) {}

    editor.focus();
    await sleep(100);

    // 2. ProseMirror View dispatch clear (safest, preserves PM state)
    const pmView = getProseMirrorView(editor);
    if (pmView && pmView.state && pmView.dispatch) {
      try {
        const tr = pmView.state.tr;
        tr.delete(0, pmView.state.doc.content.size);
        pmView.dispatch(tr);
        await sleep(150);
        return;
      } catch (_) {}
    }

    // 3. Textarea / Input clear
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.value = '';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);
      return;
    }

    // 4. Native selectAll + delete (NEVER set innerHTML directly on ProseMirror!)
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (_) {}
    await sleep(200);
  }

  async function typeIntoEditor(editor, text) {
    editor.focus();
    await sleep(200);

    // Clear existing content
    await clearPromptEditor(editor);

    // Case 1: Standard Textarea or Input
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      try {
        const proto = editor.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          setter.call(editor, text);
        } else {
          editor.value = text;
        }
      } catch (_) {
        editor.value = text;
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      return (editor.value || '').trim().length > 0;
    }

    // Case 2: execCommand insertText — sinh beforeinput/input thật nên editor framework
    // (Slate/ProseMirror/React) cập nhật state → nút Generate được enable
    try {
      editor.focus();
      document.execCommand('selectAll', false, null);
      if (document.execCommand('insertText', false, text)) {
        await sleep(300);
        if ((editor.textContent || '').trim().length > 0) {
          log('Typed via execCommand insertText');
          return true;
        }
      }
    } catch (_) {}

    // Case 2b: ProseMirror View dispatch
    const pmView = getProseMirrorView(editor);
    if (pmView && pmView.state && pmView.dispatch) {
      try {
        const tr = pmView.state.tr;
        tr.delete(0, pmView.state.doc.content.size);
        tr.insertText(text);
        pmView.dispatch(tr);
        log('Inserted via ProseMirror View dispatch');
        await sleep(300);
        if ((editor.textContent || '').trim().length > 0) {
          return true;
        }
      } catch (err) {
        log('ProseMirror dispatch error: ' + err.message, 'warning');
      }
    }

    // Case 3: Clipboard Paste Event (Triggers ProseMirror's native paste handler)
    try {
      editor.focus();
      document.execCommand('selectAll', false, null);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      editor.dispatchEvent(pasteEvt);
      await sleep(300);
      if ((editor.textContent || '').trim().length > 0) {
        log('Inserted via ClipboardEvent paste');
        return true;
      }
    } catch (_) {}

    // Case 4: ProseMirror execCommand insertText
    let typed = false;
    try {
      editor.focus();
      typed = document.execCommand('insertText', false, text);
    } catch (_) {}

    if (typed && (editor.textContent || '').trim().length > 0) {
      log('Typed via execCommand insertText');
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      return true;
    }

    // Case 5: Keyboard simulation
    editor.focus();
    for (const char of text) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      editor.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
    await sleep(300);
    return (editor.textContent || '').trim().length > 0;
  }

  // ─── Button Finding & Submission ─────────────────────────────

  function findSubmitButton(editor) {
    if (!editor) return null;
    const editorRect = editor.getBoundingClientRect();

    const isNearEditor = (btn) => {
      const r = btn.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - (editorRect.top + editorRect.bottom) / 2) < 250 &&
             r.right > editorRect.left;
    };

    // 0. Nút Generate của Google Flow: icon ligature "arrow_forward" (+ text "Create"/"Tạo")
    const arrowBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(btn => {
      const t = (btn.textContent || '').toLowerCase();
      return (t.includes('arrow_forward') || t.includes('arrow_upward')) && !t.includes('arrow_back');
    });
    const arrowNear = arrowBtns.filter(isNearEditor);
    const arrowPick = (arrowNear.length ? arrowNear : arrowBtns)
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    if (arrowPick) return arrowPick; // trả về kể cả khi đang disabled để submitPrompt chờ nó enable

    // 1. Known explicit action selectors — chỉ nút nằm gần ô prompt
    //    (tránh bấm nhầm "Create project"/"New project"... ở chỗ khác trên trang)
    for (const sel of SELECTORS.generateButton) {
      try {
        const btn = Array.from(document.querySelectorAll(sel)).find(b => isClickable(b) && isNearEditor(b));
        if (btn) return btn;
      } catch (_) {}
    }

    // 2. Proximity search: Look in parent containers of editor (up to 10 levels)
    // Find the RIGHTMOST button (furthest to the right in the prompt bar)
    let parent = editor.parentElement;
    for (let depth = 0; depth < 10 && parent; depth++) {
      const btns = Array.from(parent.querySelectorAll('button, [role="button"]'));
      if (btns.length > 0) {
        const candidates = [];
        for (const btn of btns) {
          if (!isClickable(btn)) continue;
          const rect = btn.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || rect.width > 220) continue;

          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const text = (btn.textContent || '').trim().toLowerCase();

          // Strictly filter out tools, settings, aspect-ratio, attachments, etc.
          if (label.includes('clear') || label.includes('close') || label.includes('cancel') ||
              label.includes('delete') || label.includes('xóa') || label.includes('hủy') ||
              label.includes('setting') || label.includes('help') || label.includes('aspect') ||
              label.includes('ratio') || label.includes('model') || label.includes('style') ||
              label.includes('tool') || label.includes('more') || label.includes('menu') ||
              label.includes('history') || label.includes('upload') || label.includes('image') ||
              label.includes('reference') || label.includes('attach') || label.includes('tệp') ||
              label.includes('ảnh') || label.includes('cài đặt')) {
            continue;
          }

          // In Google Flow prompt bars, Submit/Generate arrow button is ALWAYS on the RIGHT
          const isRightSide = rect.right >= editorRect.left + (editorRect.width * 0.3);
          if (!isRightSide && btns.length > 1) {
            continue;
          }

          const hasSvg = !!btn.querySelector('svg');
          const hasIcon = !!btn.querySelector('mat-icon, i, span.material-icons, flow-icon');

          candidates.push({ btn, x: rect.right, y: rect.top, hasSvg, hasIcon });
        }

        if (candidates.length > 0) {
          // Sort descending by X coordinate: RIGHTMOST BUTTON FIRST (Submit arrow →)
          candidates.sort((a, b) => b.x - a.x);
          return candidates[0].btn;
        }
      }
      parent = parent.parentElement;
    }

    // 3. Fallback: Rightmost button vertically aligned with the editor
    const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
    let rightmost = null;
    let maxX = -1;
    for (const btn of allBtns) {
      if (!isClickable(btn)) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 0 || rect.width > 120 || rect.height <= 0) continue;

      const isNearbyY = Math.abs(rect.top - editorRect.top) < 120;
      if (isNearbyY && rect.right > editorRect.left + 50 && rect.right > maxX) {
        maxX = rect.right;
        rightmost = btn;
      }
    }
    if (rightmost) return rightmost;

    return null;
  }

  function pressEnterOnEditor(editor) {
    if (!editor) return;
    editor.focus();
    const eventTypes = ['keydown', 'keypress', 'keyup'];

    // 1. Standard Enter
    for (const type of eventTypes) {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true
      }));
    }

    // 2. Ctrl+Enter & Cmd+Enter
    for (const type of eventTypes) {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      }));
    }
  }

  function editorText(editor) {
    if (!editor) return '';
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') return (editor.value || '').trim();
    return (editor.textContent || '').trim();
  }

  function countTiles() {
    return document.querySelectorAll('flow-image-tile, flow-tile, [data-tile]').length;
  }

  function requestTrusted(action, extra) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(resp || { ok: false });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  // Đã submit thành công? → ô prompt bị xóa, hoặc xuất hiện tile đang tạo / tile mới
  async function waitSubmitted(editor, before, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (before.text !== '' && editorText(editor) === '') return true;
      if (countPendingTiles() > before.pending) return true;
      if (countTiles() > before.tiles) return true;
      await sleep(250);
    }
    return false;
  }

  async function submitPrompt(editor) {
    const before = { text: editorText(editor), pending: countPendingTiles(), tiles: countTiles() };

    // Chờ tối đa 5s cho nút Generate enable (app cần thời gian nhận text)
    log('Waiting for submit button to become ready...');
    let btn = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      btn = findSubmitButton(editor);
      if (btn && isClickable(btn)) break;
      await sleep(200);
    }

    // Lần 1: click bằng JS
    if (btn) {
      log('Found submit button: ' + describeButton(btn) + (isClickable(btn) ? '' : ' (disabled?)'));
      btn.scrollIntoView({ block: 'nearest' });
      clickElement(btn);
      if (await waitSubmitted(editor, before, 3000)) { log('Submitted (JS click)'); return true; }
    } else {
      log('Không tìm thấy nút Generate', 'warning');
    }

    // Lần 2: click thật (isTrusted) qua chrome.debugger tại tọa độ nút
    btn = findSubmitButton(editor) || btn;
    if (btn) {
      const r = btn.getBoundingClientRect();
      log('JS click không có tác dụng → thử trusted click');
      const resp = await requestTrusted('flow_trusted_click', {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      });
      if (!resp.ok) log('Trusted click lỗi: ' + resp.error, 'warning');
      if (await waitSubmitted(editor, before, 3000)) { log('Submitted (trusted click)'); return true; }
    }

    // Lần 3: phím Enter thật trên ô prompt
    log('Thử trusted Enter...');
    editor.focus();
    const resp = await requestTrusted('flow_trusted_enter', {});
    if (!resp.ok) {
      log('Trusted Enter lỗi: ' + resp.error + ' → dùng Enter giả lập', 'warning');
      pressEnterOnEditor(editor);
    }
    if (await waitSubmitted(editor, before, 3000)) { log('Submitted (Enter)'); return true; }

    return false;
  }

  // ─── Generation Monitoring ──────────────────────────────────

  function countPendingTiles() {
    let count = 0;
    for (const sel of SELECTORS.pendingTile) {
      try {
        count += document.querySelectorAll(sel).length;
      } catch (_) {}
    }
    return count;
  }

  function getCompletedImages() {
    const images = [];
    const seenUrls = new Set();

    function addImage(src) {
      if (!src) return;
      if (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:image/')) return;
      const clean = src.split('?')[0];
      if (seenUrls.has(clean)) return;
      seenUrls.add(clean);
      images.push({
        url: src,
        base64: src.startsWith('data:image/') ? src.split(',')[1] : '',
        index: images.length
      });
    }

    // 1. Look for known tile images
    for (const sel of SELECTORS.tileImage) {
      try {
        document.querySelectorAll(sel).forEach(img => {
          if (img.src) addImage(img.src);
        });
      } catch (_) {}
    }

    // 2. Fallback: all large images in DOM matching Google Flow criteria
    const allImgs = document.querySelectorAll('img[src]');
    for (const img of allImgs) {
      const src = img.src || '';
      if (!img.complete || img.naturalWidth < 150 || img.naturalHeight < 150) continue;
      const lower = src.toLowerCase();
      if (lower.includes('favicon') || lower.includes('logo') || lower.includes('avatar') ||
          lower.includes('icon') || lower.includes('.svg') || lower.includes('emoji') ||
          lower.includes('profile')) continue;

      const isGoogleImg = lower.includes('googleusercontent.com') ||
                          lower.includes('storage.googleapis.com') ||
                          lower.includes('lh3.google') ||
                          lower.includes('labs.google') ||
                          lower.includes('gstatic.com') ||
                          lower.startsWith('blob:');
      const isLargeImg = img.naturalWidth >= 300 && img.naturalHeight >= 300;

      if (isGoogleImg || isLargeImg) {
        addImage(src);
      }
    }

    // 3. Fallback: canvas elements
    document.querySelectorAll('canvas').forEach(canvas => {
      if (canvas.width >= 300 && canvas.height >= 300) {
        try {
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 2000) {
            addImage(dataUrl);
          }
        } catch (_) {}
      }
    });

    return images;
  }

  async function waitForGeneration(promptId) {
    const startTime = Date.now();
    let stableCount = 0;
    let sawPending = false;
    const initialImages = getCompletedImages();
    const initialCount = initialImages.length;

    // Wait a moment for generation to initiate and tiles to appear
    await sleep(2500);

    while (Date.now() - startTime < GENERATION_TIMEOUT) {
      const pending = countPendingTiles();
      if (pending > 0) sawPending = true;
      const currentImages = getCompletedImages();
      const newImagesCount = currentImages.length - initialCount;

      // Report progress
      if (pending > 0 || newImagesCount > 0) {
        const total = pending + Math.max(newImagesCount, 1);
        const pct = Math.min(100, Math.round((Math.max(newImagesCount, 0) / total) * 100));
        sendToBackground({
          type: 'flow_progress',
          id: promptId,
          status: 'generating',
          message: `${Math.max(newImagesCount, 0)} ảnh (${pct}%) ${pending > 0 ? '[Đang tạo...]' : '[Hoàn tất]'}`
        });
      }

      // Condition A: Pending tiles cleared and new images appeared
      if (pending === 0 && currentImages.length > initialCount) {
        stableCount++;
        if (stableCount >= 2) {
          log(`Generation complete: ${currentImages.length - initialCount} new images`);
          await sleep(SETTLE_DELAY);
          return getCompletedImages();
        }
      } else if (sawPending && pending === 0 && currentImages.length > 0 && (Date.now() - startTime > 12000)) {
        // Condition B: After 12s+, pending is 0 and count is stable
        stableCount++;
        if (stableCount >= 3) {
          log(`Generation complete (stable): ${currentImages.length} images`);
          await sleep(SETTLE_DELAY);
          return getCompletedImages();
        }
      } else {
        stableCount = 0;
      }

      await sleep(POLL_INTERVAL);
    }

    // Timeout - return whatever we have
    const finalImages = getCompletedImages();
    if (finalImages.length > 0) {
      log(`Timeout but got ${finalImages.length} images`);
      return finalImages;
    }
    throw new Error('Timeout: generation took too long');
  }

  // ─── Image to Base64 conversion ─────────────────────────────

  async function imageToBase64(imgUrl) {
    if (!imgUrl) return '';
    if (imgUrl.startsWith('data:image/')) {
      return imgUrl.split(',')[1] || '';
    }
    try {
      const response = await fetch(imgUrl);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result || '').split(',')[1] || '';
          resolve(base64);
        };
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
    } catch(e) {
      log('Failed to convert image to base64: ' + e.message, 'warning');
      return '';
    }
  }

  // ─── Main Generate Handler ──────────────────────────────────

  async function handleGenerateFlow(msg) {
    if (isProcessing) {
      const now = Date.now();
      // Auto force-reset if stuck for > 4 minutes
      if (processingStartTime && (now - processingStartTime > 240000)) {
        log('Previous prompt stuck for >4min, force-resetting', 'warning');
        isProcessing = false;
      } else {
        sendToBackground({
          type: 'flow_error',
          id: msg.id,
          error: 'Đang xử lý prompt khác, vui lòng đợi.'
        });
        return;
      }
    }

    isProcessing = true;
    processingStartTime = Date.now();
    currentPromptId = msg.id;
    const prompt = msg.prompt || '';

    try {
      // Step 1: Find prompt editor
      const editor = querySelector(SELECTORS.promptEditor);
      if (!editor) {
        throw new Error('Không thể tìm thấy ô nhập prompt. Hãy đảm bảo đang ở trang project Google Flow.');
      }

      // Step 2: Count existing images before generation
      const imagesBefore = getCompletedImages().length;

      // Step 3: Type prompt
      log('Typing prompt: ' + prompt.substring(0, 60) + '...');
      sendToBackground({
        type: 'flow_progress',
        id: msg.id,
        status: 'typing',
        message: 'Đang nhập prompt...'
      });

      const typed = await typeIntoEditor(editor, prompt);
      if (!typed) {
        throw new Error('Không thể nhập prompt vào ô input');
      }

      await sleep(600);

      // Step 4: Submit prompt (Click rightmost button + Enter + Ctrl+Enter)
      sendToBackground({
        type: 'flow_progress',
        id: msg.id,
        status: 'generating',
        message: 'Đang gửi yêu cầu tạo ảnh...'
      });
      const submitted = await submitPrompt(editor);
      if (!submitted) {
        throw new Error('Đã nhập prompt nhưng không bấm được nút Generate trên Google Flow (nút không phản hồi hoặc bị disable). Mở DevTools tab Flow để xem log [BulkAI Flow].');
      }

      // Step 5: Wait for generation to complete
      await sleep(1500);

      const newImages = await waitForGeneration(msg.id);

      // Filter to only newly generated images (after imagesBefore)
      const allCurrentImages = getCompletedImages();
      let resultImages = allCurrentImages.slice(imagesBefore);
      if (resultImages.length === 0) {
        resultImages = newImages.slice(imagesBefore);
      }
      if (resultImages.length === 0 && allCurrentImages.length > 0) {
        resultImages = allCurrentImages.slice(-4);
      }
      const finalImages = resultImages.length > 0 ? resultImages : newImages;

      // Step 6: Convert to base64 for download
      const imagesWithBase64 = [];
      for (let i = 0; i < finalImages.length; i++) {
        const img = finalImages[i];
        sendToBackground({
          type: 'flow_progress',
          id: msg.id,
          status: 'downloading',
          message: `Đang tải ảnh ${i+1}/${finalImages.length}...`
        });

        const base64 = img.base64 || await imageToBase64(img.url);
        imagesWithBase64.push({
          url: img.url,
          base64: base64,
          index: i
        });
      }

      // Step 7: Send results back
      log(`Sending ${imagesWithBase64.length} images to background`);
      sendToBackground({
        type: 'flow_result',
        id: msg.id,
        prompt: prompt,
        images: imagesWithBase64
      });

    } catch(e) {
      log('Error: ' + e.message, 'error');
      sendToBackground({
        type: 'flow_error',
        id: msg.id,
        error: e.message
      });
    } finally {
      isProcessing = false;
      currentPromptId = null;
      processingStartTime = 0;
    }
  }

  // ─── Message Listener ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (window.__bulkaiFlowActiveInstance !== INSTANCE_ID) {
      return; // Ignore messages intended for other instances
    }

    const action = message.type || message.action;
    switch (action) {
      case 'generate_flow':
        handleGenerateFlow(message);
        sendResponse({ received: true });
        break;

      case 'cancel_prompt':
      case 'force_reset':
      case 'reset_flow':
        log('Force reset requested');
        isProcessing = false;
        currentPromptId = null;
        processingStartTime = 0;
        sendResponse({ reset: true });
        break;

      case 'ping':
        sendResponse({ alive: true, isProcessing, site: 'google_flow' });
        break;

      default:
        break;
    }
    return true;
  });

  // ─── Init ───────────────────────────────────────────────────

  log('Content script loaded on ' + window.location.href);
})();
