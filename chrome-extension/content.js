// BulkAI ChatGPT Bridge — Content Script
// Injects prompts into ChatGPT textarea, observes responses via MutationObserver

(() => {
  'use strict';

  // ─── Guard & Cleanup on re-injection ──────────────────────────────
  if (window.__bulkaiCleanup) {
    try { window.__bulkaiCleanup(); } catch (_) {}
  }
  window.__bulkaiCsInitialized = true;

  const DEBOUNCE_DELAY = 3000; // ms — consider response complete after 3s of no DOM changes
  const RESPONSE_TIMEOUT = 180000; // ms — max 3 minutes to wait for response
  const POLLING_INTERVAL = 1500;   // ms — polling fallback interval (giảm từ 4000 → 1500)
  const KEEPALIVE_INTERVAL = 5000; // ms — ping độc lập giữ SW khỏi bị kill

  let currentPromptId = null;
  let observer = null;
  let debounceTimer = null;
  let timeoutTimer = null;
  let pollingTimer = null;
  let keepaliveTimer = null; // SW keepalive độc lập trong suốt thời gian ChatGPT generate
  let isProcessing = false;
  let lastResponseText = '';
  let messageCountBefore = 0;
  let textareaWasCleared = false; // tracks if textarea cleared after submit

  // ─── DOM Selectors (multiple fallbacks for ChatGPT UI changes) ─────

  const SELECTORS = {
    // Textarea / input area
    textarea: [
      '#prompt-textarea',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][data-placeholder]',
      'textarea[data-id="root"]',
      'div.ProseMirror[contenteditable="true"]'
    ],
    // Send button
    sendButton: [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Gửi tin nhắn"]',
      'button[aria-label="Gửi lời nhắc"]',
      'button[aria-label="Gửi"]',
      'form button[type="submit"]',
      'button.btn-primary svg[viewBox] ~ span'
    ],
    // All assistant messages container
    // NOTE: ChatGPT now uses <article> instead of <div> — keep both!
    assistantMessages: [
      'article[data-message-author-role="assistant"]', // ChatGPT 2025+ (article)
      'div[data-message-author-role="assistant"]',     // older / fallback
      'div.agent-turn',
      '[data-message-author-role="assistant"]'         // any tag fallback
    ],
    // Stop generating / loading indicator
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Dừng tạo"]',
      'button[aria-label="Dừng tạo câu trả lời"]',
      'button[aria-label="Dừng phát trực tuyến"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="Dừng"]',
      'button[data-testid*="stop"]'
    ],
    // Thinking / loading spinner
    thinkingIndicator: [
      'div[class*="result-thinking"]',
      'div[class*="streaming"]',
      'span.result-streaming',
      '[class*="loading-spinner"]',
      'div[class*="loading"]'
    ],
    // Model selector
    modelSelector: [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[aria-haspopup="menu"][class*="model"]',
      'div[class*="model-switcher"]'
    ]
  };

  // ─── DOM Helpers ─────────────────────────────────────────────────

  function querySelector(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function querySelectorAll(selectorList) {
    for (const selector of selectorList) {
      const els = document.querySelectorAll(selector);
      if (els.length > 0) return els;
    }
    return [];
  }

  function getAssistantMessageCount() {
    const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (byRole.length > 0) return byRole.length;
    const byMd = document.querySelectorAll('.markdown');
    if (byMd.length > 0) return byMd.length;
    return querySelectorAll(SELECTORS.assistantMessages).length;
  }

  function getLastAssistantMessage() {
    const messages = querySelectorAll(SELECTORS.assistantMessages);
    if (messages.length > 0) return messages[messages.length - 1];
    const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (byRole.length > 0) return byRole[byRole.length - 1];
    return null;
  }

  function getLastAssistantText() {
    // Strategy 1: Theo container assistant
    const lastMsg = getLastAssistantMessage();
    if (lastMsg) {
      const markdownEl = lastMsg.querySelector('.markdown') ||
                         lastMsg.querySelector('[class*="markdown"]') ||
                         lastMsg.querySelector('.prose') ||
                         lastMsg;
      const text = (markdownEl.innerText || markdownEl.textContent || '').trim();
      if (text) return text;
    }

    // Strategy 2: Lấy block .markdown cuối cùng trên trang
    const markdownEls = document.querySelectorAll('.markdown, [class*="markdown"]');
    if (markdownEls.length > 0) {
      const text = (markdownEls[markdownEls.length - 1].innerText ||
                    markdownEls[markdownEls.length - 1].textContent || '').trim();
      if (text) return text;
    }

    // Strategy 3: Fallback các container turn
    const anyMsg = document.querySelector('[data-message-author-role="assistant"]:last-of-type') ||
                   document.querySelector('article:last-of-type') ||
                   document.querySelector('.agent-turn:last-child');
    if (anyMsg) {
      return (anyMsg.innerText || anyMsg.textContent || '').trim();
    }

    return '';
  }

  function isStillGenerating() {
    // 1. Check if stop button is visible ONLY inside composer / prompt form
    const composer = document.querySelector('form') ||
                     document.querySelector('#prompt-textarea')?.closest('form, div[class*="composer"]');

    if (composer) {
      const stopBtn = composer.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Dừng"], button[data-testid*="stop"]'
      );
      if (stopBtn && isElementVisible(stopBtn)) return true;

      // Check for stop square (<rect>) ONLY inside composer buttons
      const composerStopSvg = composer.querySelector('button svg rect');
      if (composerStopSvg && isElementVisible(composerStopSvg.closest('button') || composerStopSvg)) {
        return true;
      }
    }

    // Check outside composer with strict selectors only
    const strictStop = document.querySelector('button[data-testid="stop-button"]');
    if (strictStop && isElementVisible(strictStop)) return true;

    // 2. Check for thinking / streaming indicator
    const thinking = querySelector(SELECTORS.thinkingIndicator);
    if (thinking && isElementVisible(thinking)) return true;

    // 3. Check for streaming cursor
    const streamingCursor = document.querySelector('.result-streaming, [class*="result-streaming"]');
    if (streamingCursor && isElementVisible(streamingCursor)) return true;

    // CHÚ Ý: Tuyệt đối KHÔNG kiểm tra sendBtn.disabled ở đây!
    // Khi ChatGPT tạo xong phản hồi, ô nhập rỗng nên send button tự động bị disable.

    return false;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  }

  // ─── Prompt Injection ───────────────────────────────────────────

  async function injectPrompt(promptId, content) {
    if (isProcessing) {
      chrome.runtime.sendMessage({
        action: 'chatgpt_error',
        id: promptId,
        error: 'Đang xử lý prompt khác, vui lòng chờ.',
        code: 'BUSY'
      });
      return;
    }

    isProcessing = true;
    currentPromptId = promptId;
    lastResponseText = '';
    textareaWasCleared = false;

    try {
      // Record current message count
      messageCountBefore = getAssistantMessageCount();

      // Find textarea
      const textarea = querySelector(SELECTORS.textarea);
      if (!textarea) {
        throw new Error('Không tìm thấy ô nhập ChatGPT. Đảm bảo trang ChatGPT đã tải xong.');
      }

      console.log('[BulkAI] Found textarea:', textarea.tagName, textarea.id);

      // ── Step 1: Brief focus attempt (background should have already focused) ──
      window.focus();
      textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
      textarea.focus();
      await sleep(300);

      const hasFocus = document.hasFocus();
      console.log(`[BulkAI] document.hasFocus() = ${hasFocus}`);

      // ── Step 2: Inject text ──
      // Strategy waterfall (most → least reliable):
      //   A. Standard <textarea> (rare)
      //   B. execCommand insertText (requires focus, fastest for ProseMirror)
      //   C. ClipboardEvent paste (works without focus, ProseMirror handles natively)
      //   D. Direct DOM + events (last resort)
      let injected = false;

      if (textarea.tagName === 'TEXTAREA') {
        // ── A: Standard textarea ──
        textarea.value = content;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        injected = true;
        console.log('[BulkAI] Path A: textarea.value');
      }

      if (!injected) {
        // ── B: execCommand (ProseMirror div) ──
        console.log('[BulkAI] Path B: execCommand insertText');
        textarea.focus();
        await sleep(50);
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(textarea);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) {}
        document.execCommand('selectAll', false, null);
        injected = document.execCommand('insertText', false, content);
        console.log('[BulkAI] Path B execCommand result:', injected, 'len:', textarea.textContent.trim().length);
        if (!injected || textarea.textContent.trim().length === 0) {
          injected = false;
        }
      }

      if (!injected) {
        // ── C: ClipboardEvent paste (best no-focus approach) ──
        // ProseMirror / ChatGPT React has a native paste handler that:
        //   1. Reads text/plain from clipboardData
        //   2. Inserts it via its own transaction system (no DOM mutation needed)
        //   3. Updates React state correctly → send button becomes active
        console.log('[BulkAI] Path C: ClipboardEvent paste');
        textarea.focus();
        await sleep(100);

        // First clear existing content via selectAll + delete
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(50);

        const dt = new DataTransfer();
        dt.setData('text/plain', content);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        textarea.dispatchEvent(pasteEvent);
        await sleep(200); // give ProseMirror time to process paste

        injected = textarea.textContent.trim().length > 0;
        console.log('[BulkAI] Path C paste result:', injected);
      }

      if (!injected) {
        // ── D: Direct DOM mutation (last resort) ──
        // WARNING: mutating innerHTML can break ProseMirror's internal node map.
        // We minimise damage by only replacing the inner <p>, not the root div.
        console.log('[BulkAI] Path D: direct DOM mutation (last resort)');

        // Find or create the editable paragraph inside ProseMirror
        let editorP = textarea.querySelector('p');
        if (editorP) {
          editorP.textContent = content;
        } else {
          textarea.innerHTML = '';
          editorP = document.createElement('p');
          editorP.textContent = content;
          textarea.appendChild(editorP);
        }

        // Full event sequence ProseMirror + React need
        textarea.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        textarea.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: content
        }));
        textarea.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: content
        }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        textarea.offsetHeight; // force reflow

        injected = textarea.textContent.trim().length > 0;
        console.log('[BulkAI] Path D DOM result:', injected);
      }

      if (!injected || textarea.textContent.trim().length === 0) {
        throw new Error('Không thể nhập nội dung vào ô ChatGPT. Hãy thử reload trang.');
      }

      // ── Step 3: Wait for React/ProseMirror to process ──
      // Wait longer when no focus — React may batch updates differently
      const waitTime = hasFocus ? 500 : 1500;
      console.log(`[BulkAI] Waiting ${waitTime}ms for React to process...`);
      await sleep(waitTime);

      // ── Step 4: Submit prompt (Click send button OR press Enter) ──
      let sent = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const sendBtn = querySelector(SELECTORS.sendButton);
        const isBtnEnabled = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true';

        // Method 1: Click send button if enabled
        if (isBtnEnabled) {
          console.log(`[BulkAI] Click send button (attempt ${attempt + 1})`);
          try { sendBtn.click(); } catch (_) {}
          sendBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          // Sau khi click button, chờ đủ để ChatGPT xử lý — KHÔNG gửi Enter thêm!
          await sleep(1000);

        } else {
          // Method 2: Enter key — CHỈ dùng khi button thực sự không click được (tránh nhá liên tục)
          console.log(`[BulkAI] Button disabled, thử Enter (attempt ${attempt + 1})`);
          textarea.focus();
          const enterOpts = {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
          };
          textarea.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          textarea.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          await sleep(50);
          textarea.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
          await sleep(800);
        }

        // Kiểm tra xem đã gửi thành công chưa:
        const stopBtn = querySelector(SELECTORS.stopButton);
        const isStopVisible = stopBtn && isElementVisible(stopBtn);
        const textCleared = textarea && textarea.textContent.trim().length === 0;
        const msgIncreased = getAssistantMessageCount() > messageCountBefore;

        if (textCleared || isStopVisible || msgIncreased) {
          sent = true;
          textareaWasCleared = textCleared;
          console.log(`[BulkAI] Prompt đã gửi thành công (attempt ${attempt + 1}): cleared=${textCleared}, generating=${isStopVisible}, msgIncreased=${msgIncreased}`);
          break;
        }

        await sleep(400 + attempt * 200);
      }

      if (!sent) {
        throw new Error('Không thể gửi tin nhắn tới ChatGPT. Nút gửi bị vô hiệu hóa hoặc không thể submit. Vui lòng kiểm tra tab ChatGPT.');
      }

      console.log(`[BulkAI] Đã gửi prompt: ${content.substring(0, 60)}...`);

      // ── Step 5: Đợi xác nhận gửi và bắt đầu theo dõi ──
      if (!textareaWasCleared) {
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          if (textarea && textarea.textContent.trim().length === 0) {
            textareaWasCleared = true;
            console.log(`[BulkAI] Textarea cleared after ${(i + 1) * 500}ms`);
            break;
          }
        }
      }

      // Start observing for response
      await sleep(200);
      startResponseObserver();

    } catch (e) {
      isProcessing = false;
      currentPromptId = null;
      chrome.runtime.sendMessage({
        action: 'chatgpt_error',
        id: promptId,
        error: e.message,
        code: 'DOM_ERROR'
      });
    }
  }

  // ─── Response Observer ──────────────────────────────────────────

  function startResponseObserver() {
    stopResponseObserver();

    // Set overall timeout
    timeoutTimer = setTimeout(() => {
      console.log('[BulkAI] Response timeout reached');
      finishResponse('TIMEOUT');
    }, RESPONSE_TIMEOUT);

    // Start MutationObserver on the chat container
    const chatContainer = document.querySelector('main') ||
                          document.querySelector('[role="main"]') ||
                          document.body;

    observer = new MutationObserver((mutations) => {
      // Keep service worker alive
      chrome.runtime.sendMessage({ action: 'chatgpt_streaming' }).catch(() => {});

      if (!isProcessing) return;

      // Schedule debounce trên MỌI DOM change — bỏ guard cũ vì selector có thể sai
      // isStillGenerating() bên trong debounce sẽ xác định xong chưa
      scheduleDebounce();
    });

    observer.observe(chatContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // ── Keepalive heartbeat độc lập: Giữ SW sống suốt quá trình ChatGPT generate ──
    // Mục đích: MutationObserver chỉ ping khi có DOM change.
    // Nếu ChatGPT dừng "thinking" (không đổi DOM), SW vẫn cần được giữ sống.
    keepaliveTimer = setInterval(() => {
      if (!isProcessing) return;
      chrome.runtime.sendMessage({ action: 'chatgpt_streaming' }).catch(() => {});
    }, KEEPALIVE_INTERVAL);

    // ── Polling fallback + text stability detection ──
    const processingStartTime = Date.now();
    let lastSeenText = '';
    let textStablePolls = 0;

    pollingTimer = setInterval(() => {
      if (!isProcessing) return;

      const currentCount = getAssistantMessageCount();
      const hasNewMessage = currentCount > messageCountBefore;
      const elapsed = Date.now() - processingStartTime;
      const responseText = getLastAssistantText();
      const stillGen = isStillGenerating();

      // Track text stability
      if (responseText && responseText.length > 0) {
        if (responseText === lastSeenText) {
          textStablePolls++;
        } else {
          lastSeenText = responseText;
          textStablePolls = 0;
        }
      }

      console.log(`[BulkAI] Poll: msgCount=${currentCount}/${messageCountBefore}, generating=${stillGen}, stable=${textStablePolls}, textLen=${responseText.length}, elapsed=${Math.round(elapsed / 1000)}s`);

      // Trường hợp 1: Không còn tạo VÀ text đã ổn định
      if (responseText && !stillGen && textStablePolls >= 1 && (hasNewMessage || elapsed > 2500)) {
        console.log('[BulkAI] Polling: hoàn tất -> finishResponse');
        finishResponse('success');
        return;
      }

      // Trường hợp 2: Text đã dừng thay đổi từ 3s trở lên và có nội dung đáng kể (>10 ký tự)
      if (responseText && responseText.length > 10 && textStablePolls >= 2 && elapsed > 4000) {
        console.log('[BulkAI] Polling: text ổn định 3s -> finishResponse');
        finishResponse('success');
        return;
      }

      // Trường hợp 3: Safety-net sau 15s nếu đã có nội dung
      if (elapsed > 15000 && responseText && textStablePolls >= 1) {
        console.warn('[BulkAI] Safety-net: force finishResponse');
        finishResponse('success');
        return;
      }
    }, POLLING_INTERVAL);
  }

  // ─── Debounce scheduler (fixes nested-timeout hole) ─────────────

  function scheduleDebounce() {
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      if (!isProcessing) return;
      const text = getLastAssistantText();
      const stillGen = isStillGenerating();
      if (!stillGen && text) {
        console.log('[BulkAI] Debounce: hoàn tất phản hồi');
        finishResponse('success');
      } else if (stillGen) {
        // Still generating — keep rescheduling until done or timeout
        scheduleDebounce();
      } else if (text) {
        finishResponse('success');
      }
    }, DEBOUNCE_DELAY);
  }

  function stopResponseObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearDebounceTimer();
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function clearDebounceTimer() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function finishResponse(status) {
    stopResponseObserver();

    const responseHTML = getLastAssistantText();
    const promptId = currentPromptId;

    isProcessing = false;
    currentPromptId = null;

    if (!responseHTML && status !== 'TIMEOUT') {
      // Wait a bit more and retry once
      setTimeout(() => {
        const retryHTML = getLastAssistantText();
        if (retryHTML) {
          sendResponseToBackground(promptId, retryHTML, 'success');
        } else {
          sendResponseToBackground(promptId, '', status);
        }
      }, 2000);
      return;
    }

    sendResponseToBackground(promptId, responseHTML, status);
  }

  function sendResponseToBackground(promptId, content, status) {
    if (status === 'success' && content) {
      chrome.runtime.sendMessage({
        action: 'chatgpt_response',
        id: promptId,
        content: content
      });
    } else {
      chrome.runtime.sendMessage({
        action: 'chatgpt_error',
        id: promptId,
        error: status === 'TIMEOUT'
          ? 'ChatGPT không phản hồi trong thời gian cho phép.'
          : 'Không nhận được phản hồi từ ChatGPT.',
        code: status
      });
    }
  }

  // ─── Model Selection ────────────────────────────────────────────

  async function selectModel(modelName) {
    try {
      const modelBtn = querySelector(SELECTORS.modelSelector);
      if (!modelBtn) {
        console.log('[BulkAI] Không tìm thấy nút chọn model');
        return;
      }

      modelBtn.click();
      await sleep(500);

      // Find the model option in the dropdown
      const options = document.querySelectorAll('[role="option"], [role="menuitem"], li[data-testid]');
      for (const option of options) {
        if (option.textContent.toLowerCase().includes(modelName.toLowerCase())) {
          option.click();
          console.log(`[BulkAI] Đã chọn model: ${modelName}`);
          return;
        }
      }

      // Close dropdown if model not found
      modelBtn.click();
      console.log(`[BulkAI] Không tìm thấy model: ${modelName}`);
    } catch (e) {
      console.error('[BulkAI] Lỗi chọn model:', e);
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Message Listener (from background service worker) ──────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'inject_prompt':
        injectPrompt(message.id, message.content);
        sendResponse({ received: true });
        break;

      case 'select_model':
        selectModel(message.model);
        sendResponse({ received: true });
        break;

      case 'ping':
        sendResponse({ alive: true, isProcessing });
        break;
    }
    return true;
  });

  // ─── Init ───────────────────────────────────────────────────────

  console.log('[BulkAI ChatGPT Bridge] Content script loaded on', window.location.href);
})();
