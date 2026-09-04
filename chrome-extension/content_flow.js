// ============================================================
// BulkAI Google Flow Bridge - Content Script for Google Flow
// Handles prompt injection, generation monitoring, and image extraction
// Supports: flow.google.com & labs.google/fx/tools/flow
// ============================================================

(() => {
  'use strict';

  // Guard: prevent double-injection
  if (window.__bulkaiFlowCsInitialized) {
    console.log('[BulkAI Flow] Content script already running - skipping');
    return;
  }
  window.__bulkaiFlowCsInitialized = true;

  const GENERATION_TIMEOUT = 300000; // 5 minutes max per prompt
  const POLL_INTERVAL = 2000; // Check every 2 seconds
  const SETTLE_DELAY = 3000; // Wait 3s after all tiles complete

  let isProcessing = false;
  let currentPromptId = null;

  // ─── DOM Selectors ───────────────────────────────────────────

  const SELECTORS = {
    // ProseMirror rich text editor
    promptEditor: [
      'div.ProseMirror[contenteditable="true"]',
      'flow-rich-text-editor div.ProseMirror',
      '[contenteditable="true"]'
    ],
    // Generate button
    generateButton: [
      'button.generate-button',
      'button[aria-label="Generate"]',
      'button[aria-label*="generation"]'
    ],
    // Pending tiles (generation in progress)
    pendingTile: 'flow-pending-tile',
    // Image tiles (completed)
    imageTile: 'flow-image-tile',
    // Completed images inside tiles
    tileImage: 'flow-image-tile img',
    // Tile containers
    tileContainer: 'flow-tile-container',
    // Clear prompt button
    clearButton: 'button.clear-button, button[aria-label="Clear prompt"]'
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
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
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

  // ─── Prompt Injection ────────────────────────────────────────

  async function clearPromptEditor(editor) {
    // Try clear button first
    const clearBtn = document.querySelector(SELECTORS.clearButton);
    if (clearBtn) {
      clearBtn.click();
      await sleep(300);
      return;
    }
    // Check if it's just placeholder text
    const text = editor.textContent.trim();
    if (text === 'What do you want to create?' || text === '') {
      // It's placeholder or empty, just clear it
      editor.innerHTML = '<p><br></p>';
      await sleep(100);
      return;
    }
    // Fallback: select all and delete
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(200);
  }

  async function typeIntoEditor(editor, text) {
    editor.focus();
    await sleep(200);

    // Clear existing content
    await clearPromptEditor(editor);

    // Method 1: Use execCommand insertText (works with ProseMirror)
    const success = document.execCommand('insertText', false, text);
    if (success && editor.textContent.trim().length > 0) {
      log('Typed via execCommand insertText');
      return true;
    }

    // Method 2: Set innerHTML directly with ProseMirror paragraph
    editor.innerHTML = '<p>' + text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    if (editor.textContent.trim().length > 0) {
      log('Typed via innerHTML');
      return true;
    }

    // Method 3: Simulate keyboard events
    editor.focus();
    for (const char of text) {
      const keyDown = new KeyboardEvent('keydown', { key: char, bubbles: true });
      const keyPress = new KeyboardEvent('keypress', { key: char, bubbles: true });
      const inputEvt = new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true });
      const keyUp = new KeyboardEvent('keyup', { key: char, bubbles: true });
      editor.dispatchEvent(keyDown);
      editor.dispatchEvent(keyPress);
      editor.dispatchEvent(inputEvt);
      editor.dispatchEvent(keyUp);
    }
    await sleep(300);
    if (editor.textContent.trim().length > 0) {
      log('Typed via keyboard simulation');
      return true;
    }

    return false;
  }

  // ─── Generation Monitoring ──────────────────────────────────

  function countPendingTiles() {
    return document.querySelectorAll(SELECTORS.pendingTile).length;
  }

  function getCompletedImages() {
    const images = [];
    const imgElements = document.querySelectorAll(SELECTORS.tileImage);
    imgElements.forEach((img, index) => {
      if (img.src && (img.src.startsWith('http') || img.src.startsWith('blob:'))) {
        images.push({
          url: img.src,
          base64: '',
          index: index
        });
      }
    });
    return images;
  }

  async function waitForGeneration(promptId) {
    const startTime = Date.now();
    let lastPendingCount = 0;
    let stableCount = 0;

    // Wait a moment for tiles to appear
    await sleep(2000);

    while (Date.now() - startTime < GENERATION_TIMEOUT) {
      const pending = countPendingTiles();
      const images = getCompletedImages();

      // Report progress
      const total = pending + images.length;
      if (total > 0) {
        const pct = Math.round((images.length / total) * 100);
        sendToBackground({
          type: 'flow_progress',
          id: promptId,
          status: 'generating',
          message: `${images.length}/${total} images (${pct}%)`
        });
      }

      // All done: no pending tiles and we have images
      if (pending === 0 && images.length > 0) {
        stableCount++;
        if (stableCount >= 2) { // Confirm stable for 2 polls
          log(`Generation complete: ${images.length} images`);
          await sleep(SETTLE_DELAY); // Let images fully load
          return getCompletedImages(); // Re-fetch final URLs
        }
      } else {
        stableCount = 0;
      }

      lastPendingCount = pending;
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
    try {
      const response = await fetch(imgUrl);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1] || '';
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
      sendToBackground({
        type: 'flow_error',
        id: msg.id,
        error: 'Đang xử lý prompt khác, vui lòng đợi.'
      });
      return;
    }

    isProcessing = true;
    currentPromptId = msg.id;
    const prompt = msg.prompt || '';

    try {
      // Step 1: Find prompt editor
      const editor = querySelector(SELECTORS.promptEditor);
      if (!editor) {
        throw new Error('Không thể tìm thấy ô nhập prompt. Hãy đảm bảo đang ở trang project Google Flow.');
      }

      // Step 2: Count existing images before generation
      const imagesBefore = document.querySelectorAll(SELECTORS.tileImage).length;

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

      await sleep(500);

      // Step 4: Click generate button
      const genBtn = querySelector(SELECTORS.generateButton);
      if (!genBtn) {
        throw new Error('Không tìm thấy nút Generate. Hãy kiểm tra giao diện Google Flow.');
      }

      log('Clicking generate button...');
      sendToBackground({
        type: 'flow_progress',
        id: msg.id,
        status: 'generating',
        message: 'Đã nhấn Generate, đang chờ kết quả...'
      });
      genBtn.click();

      // Step 5: Wait for generation to complete
      await sleep(1500); // Wait for pending tiles to appear

      const newImages = await waitForGeneration(msg.id);

      // Filter to only newly generated images (after imagesBefore)
      // The newest images are the ones we want
      const allCurrentImages = getCompletedImages();
      const resultImages = allCurrentImages.slice(imagesBefore);
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

        const base64 = await imageToBase64(img.url);
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
    }
  }

  // ─── Message Listener ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'generate_flow':
        handleGenerateFlow(message);
        sendResponse({ received: true });
        break;

      case 'ping':
        sendResponse({ alive: true, isProcessing, site: 'google_flow' });
        break;

      default:
        // Handle action-based messages too
        if (message.action === 'ping') {
          sendResponse({ alive: true, isProcessing, site: 'google_flow' });
        }
        break;
    }
    return true;
  });

  // ─── Init ───────────────────────────────────────────────────

  log('Content script loaded on ' + window.location.href);
})();

