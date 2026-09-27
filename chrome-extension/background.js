// ============================================================
// BulkAI Google Flow Bridge - Background Service Worker
// Kết nối WebSocket với BulkAI app ↔ Content Script trên labs.google / flow.google.com
// ============================================================

const WS_URL = 'ws://localhost:8765';
let ws = null;
let reconnectTimer = null;
const RECONNECT_DELAY = 3000;
const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

// ── WebSocket Connection ────────────────────────────────────────

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[BulkAI] ✅ Đã kết nối WebSocket tới BulkAI app');
      clearReconnectTimer();
      // Gửi ping để xác nhận kết nối
      ws.send(JSON.stringify({ type: 'ping' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error('[BulkAI] Lỗi parse message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[BulkAI] WebSocket đã đóng, thử kết nối lại...');
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.log('[BulkAI] WebSocket error (BulkAI app chưa chạy?)');
      ws = null;
    };
  } catch (e) {
    console.error('[BulkAI] Không thể kết nối WebSocket:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, RECONNECT_DELAY);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.warn('[BulkAI] WebSocket chưa kết nối, không gửi được');
  }
}

// ── Handle Messages from BulkAI Server ──────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'pong':
      console.log('[BulkAI] Pong received');
      break;

    case 'prompt':
      // ChatGPT keyword generation prompt từ BulkAI app
      console.log('[BulkAI] Nhận prompt [' + msg.id + ']: ' + (msg.content || '').substring(0, 60) + '...');
      forwardPromptToChatGPT(msg);
      break;

    case 'generate_flow':
      // Server gửi prompt để generate ảnh trên Google Flow
      console.log('[BulkAI] Nhận lệnh generate_flow:', msg.prompt?.substring(0, 50));
      forwardToContentScript(msg);
      break;

    default:
      console.log('[BulkAI] Message không xác định:', msg.type);
  }
}

// ── Forward to Content Script ───────────────────────────────────

function forwardToContentScript(msg) {
  // Tìm tab Google Flow đang mở (hỗ trợ cả labs.google VÀ flow.google.com)
  const FLOW_URL_PATTERNS = [
    'https://labs.google/*',
    'https://flow.google.com/*'
  ];

  // Query tất cả tab phù hợp với một trong hai pattern
  chrome.tabs.query({ url: FLOW_URL_PATTERNS }, (tabs) => {
    if (tabs.length === 0) {
      console.warn('[BulkAI] Không tìm thấy tab Google Flow nào đang mở!');
      sendToServer({
        type: 'flow_error',
        id: msg.id,
        error: 'Không tìm thấy tab Google Flow. Vui lòng mở labs.google hoặc flow.google.com trong Chrome.'
      });
      return;
    }

    // Ưu tiên tab flow.google.com nếu có, ngược lại dùng tab đầu tiên
    const preferredTab = tabs.find(t =>
      t.url && t.url.startsWith('https://flow.google.com/')
    ) || tabs[0];

    console.log('[BulkAI] Gửi lệnh tới tab:', preferredTab.url);
    chrome.tabs.sendMessage(preferredTab.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[BulkAI] Lỗi gửi tới content script:', chrome.runtime.lastError.message);
        sendToServer({
          type: 'flow_error',
          id: msg.id,
          error: 'Không thể gửi lệnh tới tab Google Flow: ' + chrome.runtime.lastError.message
        });
      }
    });
  });
}

// ── Forward ChatGPT prompt to content script ───────────────────

async function forwardPromptToChatGPT(promptData) {
  try {
    let tabs = await chrome.tabs.query({ url: CHATGPT_URLS });

    // Tự động mở tab ChatGPT nếu chưa có
    if (tabs.length === 0) {
      console.log('[BulkAI] Chưa có tab ChatGPT, đang mở...');
      const newTab = await chrome.tabs.create({ url: 'https://chatgpt.com', active: true });
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 8000);
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await new Promise(r => setTimeout(r, 2000));
      tabs = [newTab];
    }

    const targetTab = tabs.find(t => t.active) || tabs[0];

    // Focus tab ChatGPT
    try {
      await chrome.windows.update(targetTab.windowId, { focused: true });
      await chrome.tabs.update(targetTab.id, { active: true });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn('[BulkAI] Không thể focus tab ChatGPT:', e.message);
    }

    // Kiểm tra content script có sẵn sàng không
    let contentScriptAlive = false;
    try {
      const pong = await chrome.tabs.sendMessage(targetTab.id, { action: 'ping' });
      contentScriptAlive = pong && pong.alive;
    } catch (_) {}

    // Inject content script nếu chưa có
    if (!contentScriptAlive) {
      console.log('[BulkAI] Inject content.js vào tab ChatGPT...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content.js']
        });
        await new Promise(r => setTimeout(r, 500));
      } catch (injectErr) {
        console.error('[BulkAI] Không thể inject:', injectErr.message);
        sendToServer({
          type: 'error',
          id: promptData.id,
          error: 'Không thể inject content script: ' + injectErr.message
        });
        return;
      }
    }

    // Gửi prompt tới content script
    try {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'inject_prompt',
        id: promptData.id,
        content: promptData.content
      });
      console.log('[BulkAI] Đã gửi prompt tới ChatGPT tab');
    } catch (err) {
      console.error('[BulkAI] Lỗi gửi prompt:', err.message);
      sendToServer({
        type: 'error',
        id: promptData.id,
        error: 'Lỗi gửi prompt tới ChatGPT: ' + err.message
      });
    }

  } catch (e) {
    console.error('[BulkAI] Lỗi forwardPromptToChatGPT:', e.message);
    sendToServer({
      type: 'error',
      id: promptData.id,
      error: e.message
    });
  }
}

// ── Handle Messages from Content Script ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ChatGPT response → gửi về BulkAI server
  if (msg.action === 'chatgpt_response') {
    console.log('[BulkAI] Nhận response [' + msg.id + ']: ' + (msg.content || '').substring(0, 60) + '...');
    sendToServer({
      type: 'response',
      id: msg.id,
      content: msg.content,
      status: 'success'
    });
    sendResponse({ ok: true });
    return true;
  }

  // ChatGPT error → gửi về BulkAI server
  if (msg.action === 'chatgpt_error') {
    console.error('[BulkAI] Lỗi ChatGPT [' + msg.id + ']: ' + msg.error);
    sendToServer({
      type: 'error',
      id: msg.id,
      error: msg.error
    });
    sendResponse({ ok: true });
    return true;
  }

  // ChatGPT streaming keepalive
  if (msg.action === 'chatgpt_streaming') {
    sendResponse({ ok: true });
    return true;
  }

  // Google Flow results
  if (msg.type === 'flow_result' || msg.type === 'flow_progress' || msg.type === 'flow_error') {
    sendToServer(msg);
  }
  sendResponse({ ok: true });
  return true;
});

// ── Auto-connect on startup ─────────────────────────────────────

connectWebSocket();

// Re-connect khi service worker được đánh thức
self.addEventListener('activate', () => {
  connectWebSocket();
});
