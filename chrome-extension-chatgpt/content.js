// BulkAI ChatGPT Bridge — Content Script  
// Injects prompts into ChatGPT textarea, observes responses via MutationObserver

(() => {
  'use strict';

  // ─── Guard & Cleanup on re-injection ──────────────────────────────
  if (window.__bulkaiCleanup) {
    try { window.__bulkaiCleanup(); } catch (_) {}
  }

  // Instance ID: chỉ instance MỚI NHẤT xử lý messages
  const INSTANCE_ID = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  window.__bulkaiActiveInstance = INSTANCE_ID;
  window.__bulkaiCsInitialized = true;

  const DEBOUNCE_DELAY = 3000; // ms — consider response complete after 3s of no DOM changes
  const RESPONSE_TIMEOUT = 180000; // ms — max 3 minutes to wait for response
  const POLLING_INTERVAL = 1500;   // ms — polling fallback interval
  const KEEPALIVE_INTERVAL = 5000; // ms — ping độc lập giữ SW khỏi bị kill

  let currentPromptId = null;
  let observer = null;
  let debounceTimer = null;
  let timeoutTimer = null;
  let pollingTimer = null;
  let keepaliveTimer = null;
  let isProcessing = false;
  let lastResponseText = '';
  let messageCountBefore = 0;
  let textareaWasCleared = false;

  // ─── DOM Selectors (multiple fallbacks for ChatGPT UI changes) ─────

  const SELECTORS = {
    textarea: [
      '#prompt-textarea',
      'div[role="textbox"]',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[data-id="root"]',
      'div.ProseMirror[contenteditable="true"]'
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Gửi tin nhắn"]',
      'button[aria-label="Gửi lời nhắc"]',
      'button[aria-label="Gửi"]',
      'form button[type="submit"]'
    ],
    assistantMessages: [
      'article[data-message-author-role="assistant"]',
      'div[data-message-author-role="assistant"]',
      'div.agent-turn',
      '[data-message-author-role="assistant"]'
    ],
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
    thinkingIndicator: [
      'div[class*="result-thinking"]',
      'div[class*="streaming"]',
      'span.result-streaming',
      '[class*="loading-spinner"]',
      'div[class*="loading"]'
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

  function getLastAssistantText() {
    // Lấy message cuối cùng dựa trên data-message-author-role
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const markdownEl = lastMsg.querySelector('.markdown') ||
                         lastMsg.querySelector('[class*="markdown"]') ||
                         lastMsg.querySelector('.prose') ||
                         lastMsg;
      const text = (markdownEl.innerText || markdownEl.textContent || '').trim();
      if (text) return text;
    }

    // Fallback: .markdown blocks
    const markdownEls = document.querySelectorAll('.markdown, [class*="markdown"]');
    if (markdownEls.length > 0) {
      const text = (markdownEls[markdownEls.length - 1].innerText ||
                    markdownEls[markdownEls.length - 1].textContent || '').trim();
      if (text) return text;
    }

    return '';
  }

  function isStillGenerating() {
    // Check stop button inside composer
    const composer = document.querySelector('form') ||
                     document.querySelector('#prompt-textarea')?.closest('form, div[class*="composer"]');

    if (composer) {
      const stopBtn = composer.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Dừng"], button[data-testid*="stop"]'
      );
      if (stopBtn && isElementVisible(stopBtn)) return true;

      const composerStopSvg = composer.querySelector('button svg rect');
      if (composerStopSvg && isElementVisible(composerStopSvg.closest('button') || composerStopSvg)) {
        return true;
      }
    }

    const strictStop = document.querySelector('button[data-testid="stop-button"]');
    if (strictStop && isElementVisible(strictStop)) return true;

    const thinking = querySelector(SELECTORS.thinkingIndicator);
    if (thinking && isElementVisible(thinking)) return true;

    const streamingCursor = document.querySelector('.result-streaming, [class*="result-streaming"]');
    if (streamingCursor && isElementVisible(streamingCursor)) return true;

    return false;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  }

  // ─── Prompt Injection ───────────────────────────────────────────

  async function injectPrompt(promptId, content) {
    // KHÔNG kiểm tra isProcessing — background.js đã force_reset trước khi gửi
    // Nếu vẫn processing từ prompt cũ, reset ngay
    if (isProcessing) {
      console.log('[BulkAI] ⚠️ Still processing, force reset before new prompt');
      stopResponseObserver();
      isProcessing = false;
      currentPromptId = null;
    }

    isProcessing = true;
    currentPromptId = promptId;
    lastResponseText = '';
    textareaWasCleared = false;

    try {
      // Record current message count BEFORE injecting
      messageCountBefore = getAssistantMessageCount();
      console.log(`[BulkAI] === New prompt [${promptId}] === msgCount before: ${messageCountBefore}`);

      // Find textarea
      const textarea = querySelector(SELECTORS.textarea);
      if (!textarea) {
        throw new Error('Không tìm thấy ô nhập ChatGPT.');
      }

      // Focus
      window.focus();
      textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
      textarea.focus();
      await sleep(300);

      // ── Inject text ──
      let injected = false;

      if (textarea.tagName === 'TEXTAREA') {
        textarea.value = content;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        injected = true;
      }

      if (!injected) {
        // Try execCommand insertText
        textarea.focus();
        textarea.textContent = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(100);

        const ok = document.execCommand('insertText', false, content);
        if (ok && textarea.textContent.trim().length > 0) {
          injected = true;
          console.log('[BulkAI] Injected via execCommand');
        }
      }

      if (!injected) {
        // Clipboard paste fallback
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', content);
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt
          });
          textarea.dispatchEvent(pasteEvent);
          await sleep(300);
          if (textarea.textContent.trim().length > 0 || textarea.innerHTML.includes(content.substring(0, 20))) {
            injected = true;
            console.log('[BulkAI] Injected via paste');
          }
        } catch (_) {}
      }

      if (!injected) {
        // Direct DOM manipulation
        textarea.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = content;
        textarea.appendChild(p);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        injected = true;
        console.log('[BulkAI] Injected via DOM');
      }

      await sleep(500);

      // ── Submit ──
      let sent = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const sendBtn = querySelector(SELECTORS.sendButton);

        if (sendBtn && !sendBtn.disabled) {
          try { sendBtn.click(); } catch (_) {}
          sendBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await sleep(1000);
        } else {
          // Enter key fallback
          console.log(`[BulkAI] Button disabled/missing, using Enter (attempt ${attempt + 1})`);
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

        // Check if sent
        const stopBtn = querySelector(SELECTORS.stopButton);
        const isStopVisible = stopBtn && isElementVisible(stopBtn);
        const textCleared = textarea && textarea.textContent.trim().length === 0;
        const msgIncreased = getAssistantMessageCount() > messageCountBefore;

        if (textCleared || isStopVisible || msgIncreased) {
          sent = true;
          textareaWasCleared = textCleared;
          console.log(`[BulkAI] Prompt sent (attempt ${attempt + 1}): cleared=${textCleared}, stop=${isStopVisible}, newMsg=${msgIncreased}`);
          break;
        }

        await sleep(400 + attempt * 200);
      }

      if (!sent) {
        throw new Error('Không thể gửi tin nhắn tới ChatGPT.');
      }

      // Wait for textarea to clear
      if (!textareaWasCleared) {
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          if (textarea && textarea.textContent.trim().length === 0) {
            textareaWasCleared = true;
            break;
          }
        }
      }

      // Start observing for response
      await sleep(200);
      startResponseObserver();

    } catch (e) {
      console.error('[BulkAI] injectPrompt error:', e.message);
      isProcessing = false;
      currentPromptId = null;
      sendResponseToBackground(promptId, '', 'ERROR: ' + e.message);
    }
  }

  // ─── Response Observer ──────────────────────────────────────────

  function startResponseObserver() {
    stopResponseObserver();

    // Overall timeout
    timeoutTimer = setTimeout(() => {
      console.log('[BulkAI] Response timeout reached');
      finishResponse('TIMEOUT');
    }, RESPONSE_TIMEOUT);

    // MutationObserver
    const chatContainer = document.querySelector('main') ||
                          document.querySelector('[role="main"]') ||
                          document.body;

    observer = new MutationObserver(() => {
      chrome.runtime.sendMessage({ action: 'chatgpt_streaming' }).catch(() => {});
      if (!isProcessing) return;
      scheduleDebounce();
    });

    observer.observe(chatContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Keepalive heartbeat
    keepaliveTimer = setInterval(() => {
      if (!isProcessing) return;
      chrome.runtime.sendMessage({ action: 'chatgpt_streaming' }).catch(() => {});
    }, KEEPALIVE_INTERVAL);

    // ── Polling fallback + text stability ──
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

      console.log(`[BulkAI] Poll: count=${currentCount}/${messageCountBefore}, gen=${stillGen}, stable=${textStablePolls}, len=${responseText.length}, ${Math.round(elapsed / 1000)}s`);

      // Case 1: Done generating + text stable + new message exists
      if (responseText && !stillGen && textStablePolls >= 1 && (hasNewMessage || elapsed > 2500)) {
        console.log('[BulkAI] Polling: response complete');
        finishResponse('success');
        return;
      }

      // Case 2: Text stable for 3s+ with >10 chars
      if (responseText && responseText.length > 10 && textStablePolls >= 2 && elapsed > 4000) {
        console.log('[BulkAI] Polling: text stable 3s+');
        finishResponse('success');
        return;
      }

      // Case 3: Safety net after 15s
      if (elapsed > 15000 && responseText && textStablePolls >= 1) {
        console.warn('[BulkAI] Safety-net: force finishResponse');
        finishResponse('success');
        return;
      }
    }, POLLING_INTERVAL);
  }

  // ─── Debounce scheduler ─────────────────────────────────────────

  function scheduleDebounce() {
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      if (!isProcessing) return;
      const text = getLastAssistantText();
      const stillGen = isStillGenerating();
      if (!stillGen && text) {
        console.log('[BulkAI] Debounce: response complete');
        finishResponse('success');
      } else if (stillGen) {
        scheduleDebounce();
      } else if (text) {
        finishResponse('success');
      }
    }, DEBOUNCE_DELAY);
  }

  function stopResponseObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    clearDebounceTimer();
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }

  function clearDebounceTimer() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function finishResponse(status) {
    stopResponseObserver();

    const promptId = currentPromptId;
    isProcessing = false;
    currentPromptId = null;

    // Lấy response text - phải là message MỚI (sau messageCountBefore)
    const currentCount = getAssistantMessageCount();
    let responseText = '';

    if (currentCount > messageCountBefore) {
      // Có message mới → lấy text từ message cuối
      responseText = getLastAssistantText();
    } else {
      // Chưa có message mới → retry 1 lần
      console.log('[BulkAI] No new message yet, retrying in 2s...');
    }

    console.log(`[BulkAI] finishResponse: status=${status}, promptId=${promptId}, textLen=${responseText.length}, msgCount=${currentCount}/${messageCountBefore}`);

    if (responseText && status === 'success') {
      sendResponseToBackground(promptId, responseText, 'success');
    } else if (!responseText && status === 'success') {
      // Text empty, retry once
      setTimeout(() => {
        const retryText = getLastAssistantText();
        const retryCount = getAssistantMessageCount();
        console.log(`[BulkAI] Retry: textLen=${retryText.length}, count=${retryCount}`);
        if (retryText && retryCount > messageCountBefore) {
          sendResponseToBackground(promptId, retryText, 'success');
        } else {
          sendResponseToBackground(promptId, retryText || '', 'NO_RESPONSE');
        }
      }, 2000);
    } else {
      sendResponseToBackground(promptId, '', status);
    }
  }

  function sendResponseToBackground(promptId, content, status) {
    if (!promptId) return;

    if (status === 'success' && content) {
      console.log(`[BulkAI] ✅ Sending response [${promptId}]: ${content.substring(0, 80)}...`);
      chrome.runtime.sendMessage({
        action: 'chatgpt_response',
        id: promptId,
        content: content
      }).catch(e => console.error('[BulkAI] Send response error:', e));
    } else {
      console.log(`[BulkAI] ✗ Sending error [${promptId}]: ${status}`);
      chrome.runtime.sendMessage({
        action: 'chatgpt_error',
        id: promptId,
        error: status === 'TIMEOUT'
          ? 'ChatGPT không phản hồi trong thời gian cho phép.'
          : 'Không nhận được phản hồi: ' + status,
        code: status
      }).catch(e => console.error('[BulkAI] Send error error:', e));
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Message Listener (from background service worker) ──────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Chỉ instance mới nhất xử lý — old instances ignore
    if (window.__bulkaiActiveInstance !== INSTANCE_ID) {
      return false;
    }

    switch (message.action) {
      case 'inject_prompt':
        injectPrompt(message.id, message.content);
        sendResponse({ received: true });
        break;

      case 'cancel_prompt':
        console.log('[BulkAI] Cancel prompt, resetting...');
        stopResponseObserver();
        isProcessing = false;
        currentPromptId = null;
        sendResponse({ cancelled: true });
        break;

      case 'force_reset':
        console.log('[BulkAI] Force reset');
        stopResponseObserver();
        isProcessing = false;
        currentPromptId = null;
        lastResponseText = '';
        messageCountBefore = 0;
        sendResponse({ reset: true });
        break;

      case 'ping':
        sendResponse({ alive: true, isProcessing });
        break;
    }
    return true;
  });

  // ─── Cleanup function ──────────────────────────────────────────

  window.__bulkaiCleanup = () => {
    stopResponseObserver();
    isProcessing = false;
    currentPromptId = null;
  };

  console.log('[BulkAI ChatGPT Bridge] Content script loaded on', window.location.href);
})();
