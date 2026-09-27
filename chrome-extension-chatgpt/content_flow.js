// ============================================================
// BulkAI Google Flow Bridge - Content Script
// Chạy trên labs.google/* và flow.google.com/*
// — tự động nhập prompt và thu thập ảnh từ Google Flow
// ============================================================

(() => {
  'use strict';

  // Guard: prevent double-injection
  if (window.__bulkaiFlowInitialized) {
    console.log('[BulkAI Flow] Content script already running — skipping');
    return;
  }
  window.__bulkaiFlowInitialized = true;

  console.log('[BulkAI Flow] Content script loaded on', window.location.href);

  // ── Listen for messages from background.js ──────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'generate_flow':
        handleGenerateFlow(msg);
        sendResponse({ received: true });
        break;
      case 'ping':
        sendResponse({ alive: true });
        break;
    }
    return true;
  });

  // ── Main Generate Flow Handler ──────────────────────────────────

  async function handleGenerateFlow(msg) {
    const { id, prompt, flowUrl } = msg;
    
    try {
      // Báo tiến độ: đang nhập prompt
      sendProgress(id, 'typing', 'Đang nhập prompt...');

      // 1. Tìm input element (retry nếu chưa thấy)
      let input = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        input = findInputElement();
        if (input) break;
        console.log(`[BulkAI Flow] Chưa tìm thấy input, thử lại (${attempt + 1}/5)...`);
        await sleep(2000);
      }
      if (!input) {
        sendError(id, 'Không tìm thấy ô nhập prompt trên trang Google Flow. Đảm bảo trang đã load xong.');
        return;
      }

      // 2. Snapshot ảnh hiện tại (fingerprint URLs để so sánh sau submit)
      const existingFingerprints = getImageFingerprints();
      console.log('[BulkAI Flow] Existing image fingerprints:', existingFingerprints.size);

      // 3. Nhập prompt — inject vào MAIN world để framework nhận
      //    Content script chạy trong isolated world, execCommand/InputEvent
      //    từ isolated world không trigger Lexical/Draft.js state update.
      //    Phải inject script vào page context (MAIN world).
      
      console.log('[BulkAI Flow] Injecting prompt via MAIN world script...');
      
      // Method 1: Inject script vào page context
      const injectionResult = await injectPromptViaPageScript(input, prompt);
      
      if (!injectionResult) {
        sendError(id, 'Không thể nhập prompt vào ô input');
        return;
      }
      
      console.log('[BulkAI Flow] ✅ Prompt injection initiated');

      // 4. Chờ framework xử lý prompt (quan trọng!)
      sendProgress(id, 'waiting', 'Đợi Google Flow xử lý prompt...');
      await sleep(3000);

      // 5. Verify — kiểm tra DOM có text không
      const finalText = getInputText(input);
      console.log('[BulkAI Flow] Final text check:', finalText?.substring(0, 60));
      // Không fail nếu text trống — có thể framework đã move text đi nơi khác
      // Chỉ log warning
      if (!finalText || finalText.length < 5) {
        console.log('[BulkAI Flow] ⚠️ Text không thấy trong DOM, nhưng vẫn thử submit...');
      }

      // 6. Click nút submit
      const submitted = await clickSubmitButton();
      if (!submitted) {
        sendError(id, 'Không tìm thấy nút Submit');
        return;
      }
      sendProgress(id, 'generating', 'Đã submit! Đang chờ ảnh...');

      // 7. Chờ ảnh mới render (so sánh fingerprints)
      const newImageUrls = await waitForNewImages(existingFingerprints, 180000); // 3 phút timeout
      if (newImageUrls.length === 0) {
        sendError(id, 'Không tìm thấy ảnh mới sau khi chờ');
        return;
      }

      console.log('[BulkAI Flow] ✅ Tìm thấy', newImageUrls.length, 'ảnh mới');

      // 8. Giới hạn 4 ảnh mới nhất + upgrade URL sang full-size
      const MAX_IMAGES = 4;
      const imagesToDownload = newImageUrls.slice(0, MAX_IMAGES).map(url => {
        // Google image CDN: =s256 = thumbnail, =s0 hoặc =s1024 = full size
        let fullUrl = url;
        // Pattern: =s{number} hoặc =w{number}-h{number}
        fullUrl = fullUrl.replace(/=s\d+(-[a-z])?$/, '=s1024');
        fullUrl = fullUrl.replace(/=w\d+-h\d+(-[a-z])?$/, '=s1024');
        // Nếu URL chưa có size param, thêm =s1024
        if (fullUrl === url && fullUrl.includes('googleusercontent.com') && !fullUrl.includes('=s')) {
          fullUrl += '=s1024';
        }
        if (fullUrl !== url) {
          console.log(`[BulkAI Flow] Upgraded URL: ${url.substring(0, 60)} → ${fullUrl.substring(0, 60)}`);
        }
        return fullUrl;
      });

      console.log(`[BulkAI Flow] Downloading ${imagesToDownload.length} images (max ${MAX_IMAGES})`);

      // 9. Download ảnh qua canvas/fetch (bypass CORS)
      const results = [];
      for (let i = 0; i < imagesToDownload.length; i++) {
        sendProgress(id, 'downloading', `Đang download ảnh ${i + 1}/${imagesToDownload.length}...`);
        
        const base64 = await downloadImageAsBase64(imagesToDownload[i]);
        if (base64) {
          results.push({
            url: imagesToDownload[i],
            base64: base64,
            index: i
          });
        }
      }

      // 10. Gửi kết quả về
      sendResult(id, prompt, results);

    } catch (err) {
      console.error('[BulkAI Flow] Error:', err);
      sendError(id, err.message || 'Lỗi không xác định');
    }
  }

  // ── Native Input via Chrome Debugger ────────────────────────────
  // Google Flow dùng Lexical/Angular — CHỈ nhận native keyboard events.
  // execCommand, paste, DOM mutation đều KHÔNG trigger framework state.
  // Giải pháp: dùng Chrome Debugger API (Input.insertText) từ background.js
  // để simulate gõ phím thật ở browser level.

  async function injectPromptViaPageScript(inputEl, prompt) {
    // Bước 1: Focus vào input bằng click thật
    inputEl.focus();
    inputEl.click();
    await sleep(500);
    
    // Bước 2: Clear existing text (Ctrl+A → Delete)
    // Gửi qua background.js để dùng chrome.debugger
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'debugger_type_text',
        prompt: prompt
      }, (response) => {
        console.log('[BulkAI Flow] Debugger type response:', response);
        resolve(response && response.success);
      });
      
      // Timeout fallback
      setTimeout(() => resolve(false), 30000);
    });
  }

  // ── DOM Interaction ─────────────────────────────────────────────

  function findInputElement() {
    // Google Flow dùng div[role="textbox"] (KHÔNG phải contenteditable="true")
    const roleTextbox = document.querySelector('[role="textbox"]');
    if (roleTextbox && roleTextbox.offsetParent !== null) return roleTextbox;

    // Fallback: contenteditable
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce && ce.offsetParent !== null) return ce;

    // Fallback: textarea
    const ta = document.querySelector('textarea');
    if (ta && ta.offsetParent !== null) return ta;

    // Fallback: input text
    const inp = document.querySelector('input[type="text"]');
    if (inp && inp.offsetParent !== null) return inp;

    return null;
  }

  function getInputText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return (el.value || '').trim();
    }
    // Contenteditable
    const text = (el.innerText || el.textContent || '').trim();
    // Lọc placeholder
    const placeholders = ['Bạn muốn tạo gì?', 'What do you want to create?'];
    for (const ph of placeholders) {
      if (text === ph) return '';
      if (text.startsWith(ph)) return text.substring(ph.length).trim();
    }
    return text;
  }

  async function typePrompt(el, prompt) {
    el.focus();
    await sleep(200);

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = prompt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Contenteditable — dùng execCommand (framework-friendly)
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(300);
      el.focus();
      document.execCommand('insertText', false, prompt);
    }
    await sleep(500);
  }

  async function typePromptViaPaste(el, prompt) {
    el.focus();
    await sleep(100);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    
    const dt = new DataTransfer();
    dt.setData('text/plain', prompt);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    el.dispatchEvent(pasteEvent);
    await sleep(300);
  }

  // Helper: check if button is truly disabled (native OR aria-disabled)
  function isBtnDisabled(btn) {
    if (btn.disabled) return true;
    const ariaDisabled = btn.getAttribute('aria-disabled');
    return ariaDisabled === 'true';
  }

  // Find the submit button and return its center coordinates
  function findSubmitButtonCoords() {
    const allBtns = document.querySelectorAll('button');
    
    // Strategy 1: arrow_forward + Create
    for (const btn of allBtns) {
      if (btn.offsetParent === null) continue;
      const text = (btn.textContent || '').trim();
      if (text.includes('arrow_forward') && text.includes('Create') && !isBtnDisabled(btn)) {
        const rect = btn.getBoundingClientRect();
        console.log(`[BulkAI Flow] Found submit button: "${text.substring(0, 30)}" at (${rect.x}, ${rect.y})`);
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    
    // Strategy 2: arrow_forward only
    for (const btn of allBtns) {
      if (btn.offsetParent === null || isBtnDisabled(btn)) continue;
      const text = (btn.textContent || '').trim();
      if (text.includes('arrow_forward')) {
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    
    // Strategy 3: Create (no add_2)
    for (const btn of allBtns) {
      if (btn.offsetParent === null || isBtnDisabled(btn)) continue;
      const text = (btn.textContent || '').trim();
      if (text.includes('Create') && !text.includes('add_2')) {
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    
    return null;
  }

  async function clickSubmitButton() {
    // Retry up to 8 times — button aria-disabled changes from true→false
    for (let retry = 0; retry < 8; retry++) {
      if (retry > 0) {
        console.log(`[BulkAI Flow] Submit retry ${retry}/8, waiting 2s...`);
        await sleep(2000);
      }

      const coords = findSubmitButtonCoords();
      if (coords) {
        console.log(`[BulkAI Flow] Clicking submit via debugger at (${coords.x}, ${coords.y})`);
        const result = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'debugger_click',
            x: coords.x,
            y: coords.y
          }, (response) => {
            resolve(response && response.success);
          });
          setTimeout(() => resolve(false), 5000);
        });
        if (result) {
          console.log('[BulkAI Flow] ✅ Submit clicked via debugger');
          return true;
        }
      } else {
        // Log all buttons for debugging
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
          if (btn.offsetParent === null) continue;
          const text = (btn.textContent || '').trim();
          if (text.includes('Create') || text.includes('arrow_forward')) {
            console.log(`[BulkAI Flow] Button: "${text.substring(0, 40)}" disabled=${btn.disabled} aria-disabled=${btn.getAttribute('aria-disabled')}`);
          }
        }
      }
    }

    console.log('[BulkAI Flow] ❌ Submit button not found/clicked after 8 retries');
    return false;
  }

  // ── Image Detection (Google Flow Cards) ──────────────────────────
  // Google Flow hiển thị ảnh trong cards: div[role="button"] > a[href*="/edit/"] > img
  // 4 ảnh mới nhất LUÔN ở trên cùng (đầu tiên trong DOM)

  function getFlowCardImages() {
    const results = [];
    
    // Method 1: Tìm img trong link /edit/ (chính xác nhất)
    const editLinks = document.querySelectorAll('a[href*="/edit/"]');
    for (const link of editLinks) {
      const img = link.querySelector('img');
      if (img && img.src && img.offsetParent !== null) {
        const rect = img.getBoundingClientRect();
        if (rect.width >= 50 && rect.height >= 50) {
          results.push(img.src);
        }
      }
    }
    
    if (results.length > 0) {
      console.log(`[BulkAI Flow] Found ${results.length} card images via /edit/ links`);
      return results;
    }
    
    // Method 2: Fallback — tìm tất cả img lớn, sort theo Y position
    const allImgs = document.querySelectorAll('img');
    const bigImgs = [];
    for (const img of allImgs) {
      const src = img.src || '';
      if (!src || src.includes('avatar') || src.includes('icon') || 
          src.includes('logo') || src.includes('favicon')) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 80 && img.offsetParent !== null) {
        bigImgs.push({ src: img.src, y: rect.y });
      }
    }
    // Sort by Y (top first = newest)
    bigImgs.sort((a, b) => a.y - b.y);
    
    console.log(`[BulkAI Flow] Found ${bigImgs.length} big images (fallback)`);
    return bigImgs.map(i => i.src);
  }

  function getTop4NewestImages() {
    const allCardImages = getFlowCardImages();
    // Luôn lấy 4 đầu tiên = 4 mới nhất
    const top4 = allCardImages.slice(0, 4);
    console.log(`[BulkAI Flow] Top 4 newest: ${top4.length} images`);
    top4.forEach((src, i) => {
      console.log(`[BulkAI Flow]   [${i}]: ${src.substring(0, 100)}`);
    });
    return top4;
  }

  // Record initial image IDs/srcs before submit
  function getImageFingerprints() {
    const imgs = getFlowCardImages();
    return new Set(imgs.map(src => {
      // Extract unique part of URL to compare
      try {
        const url = new URL(src);
        return url.pathname + url.search;
      } catch {
        return src;
      }
    }));
  }

  async function waitForNewImages(previousFingerprints, timeout = 180000) {
    const start = Date.now();
    let stableCount = 0;
    let lastNewUrls = [];

    console.log(`[BulkAI Flow] Waiting for new images... (known: ${previousFingerprints.size}, timeout: ${timeout}ms)`);

    while (Date.now() - start < timeout) {
      await sleep(3000);

      // Keep service worker alive
      chrome.runtime.sendMessage({ action: 'chatgpt_streaming' }).catch(() => {});

      // Lấy 4 ảnh đầu tiên (mới nhất)
      const top4 = getTop4NewestImages();
      
      // Lọc ảnh mới (không có trong fingerprints trước đó)
      const newUrls = top4.filter(src => {
        try {
          const url = new URL(src);
          const fp = url.pathname + url.search;
          return !previousFingerprints.has(fp);
        } catch {
          return !previousFingerprints.has(src);
        }
      });

      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[BulkAI Flow] Image check: top4=${top4.length}, new=${newUrls.length}, elapsed=${elapsed}s`);

      if (newUrls.length > 0) {
        // Check stability — ảnh không thay đổi sau 2 lần check liên tiếp
        const urlsStr = JSON.stringify(newUrls);
        const lastStr = JSON.stringify(lastNewUrls);
        if (urlsStr === lastStr) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`[BulkAI Flow] ✅ Images stable! Found ${newUrls.length} new images`);
            return newUrls;
          }
        } else {
          stableCount = 0;
        }
        lastNewUrls = newUrls;
      }
    }

    console.log('[BulkAI Flow] ⏱️ Timeout reached');
    // Return whatever new images we found
    const top4 = getTop4NewestImages();
    return top4.filter(src => {
      try {
        const url = new URL(src);
        return !previousFingerprints.has(url.pathname + url.search);
      } catch {
        return !previousFingerprints.has(src);
      }
    });
  }

  // ── Image Download via Canvas ───────────────────────────────────

  async function downloadImageAsBase64(url) {
    try {
      // Method 1: Canvas draw
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      const loaded = await new Promise((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
        setTimeout(() => resolve(false), 10000);
      });

      if (loaded && img.naturalWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        try {
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 100) {
            console.log('[BulkAI Flow] Canvas download OK:', Math.round(dataUrl.length / 1024), 'KB');
            return dataUrl.split(',')[1];
          }
        } catch (e) {
          console.log('[BulkAI Flow] Canvas tainted, thử fetch...');
        }
      }

      // Method 2: Fetch with credentials
      const resp = await fetch(url, { credentials: 'include' });
      if (resp.ok) {
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            console.log('[BulkAI Flow] Fetch download OK:', Math.round(base64.length / 1024), 'KB');
            resolve(base64);
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      }

      return null;
    } catch (e) {
      console.error('[BulkAI Flow] Download error:', e);
      return null;
    }
  }

  // ── Communication with Background ───────────────────────────────

  function sendProgress(id, status, message) {
    chrome.runtime.sendMessage({
      action: 'flow_progress',
      id, status, message
    });
  }

  function sendResult(id, prompt, images) {
    chrome.runtime.sendMessage({
      action: 'flow_result',
      id, prompt, images
    });
  }

  function sendError(id, error) {
    chrome.runtime.sendMessage({
      action: 'flow_error',
      id, error
    });
  }

  // ── Utilities ───────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
