// ============================================================
// BulkAI Bridge - Background Service Worker (unified)
// Handles ChatGPT keyword generation + Google Flow image generation
// ============================================================

const CONFIG = {
  WS_URL: 'ws://127.0.0.1:8765',
  RECONNECT_DELAY: 3000,
  MAX_RECONNECT: 100,
  HEARTBEAT_INTERVAL: 10000
};

const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const FLOW_URLS    = ['https://labs.google/*', 'https://flow.google.com/*'];

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let pendingMessages = []; // Buffer khi WS chưa kết nối

// ── Keepalive Alarm (chống MV3 SW bị kill) ─────────────────────

function startKeepalive() {
  chrome.alarms.create('bulkai_keepalive', { periodInMinutes: 0.4 }); // ~24s
}

function stopKeepalive() {
  chrome.alarms.clear('bulkai_keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bulkai_keepalive') {
    // Ping để giữ SW sống + kiểm tra WS
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

// ── WebSocket Connection ────────────────────────────────────────

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  if (reconnectAttempts >= CONFIG.MAX_RECONNECT) {
    console.log('[BulkAI] Quá số lần reconnect');
    return;
  }

  try {
    console.log('[BulkAI] Đang kết nối WebSocket...');
    ws = new WebSocket(CONFIG.WS_URL);

    ws.onopen = () => {
      console.log('[BulkAI] ✅ Đã kết nối WebSocket tới BulkAI app');
      reconnectAttempts = 0;
      clearReconnectTimer();
      startHeartbeat();
      startKeepalive();

      // Flush pending messages
      if (pendingMessages.length > 0) {
        console.log('[BulkAI] Flush', pendingMessages.length, 'pending messages');
        const toFlush = [...pendingMessages];
        pendingMessages = [];
        for (const msg of toFlush) {
          try { ws.send(JSON.stringify(msg)); } catch (e) {}
        }
      }
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
      console.log('[BulkAI] WebSocket đã đóng');
      ws = null;
      stopHeartbeat();
      scheduleReconnect();
    };

    ws.onerror = () => {
      console.log('[BulkAI] WebSocket error (BulkAI app chưa chạy?)');
    };
  } catch (e) {
    console.error('[BulkAI] Không thể kết nối:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectAttempts++;
  const delay = Math.min(CONFIG.RECONNECT_DELAY * reconnectAttempts, 15000);
  reconnectTimer = setTimeout(() => connectWebSocket(), delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ── Heartbeat ───────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Send to BulkAI app (with buffering) ─────────────────────────

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return;
  }

  // Buffer message + try reconnect
  console.warn('[BulkAI] WS chưa kết nối — buffer message type=' + msg.type);
  pendingMessages.push(msg);
  if (pendingMessages.length > 20) pendingMessages.shift();
  connectWebSocket();
}

// ── Handle Messages from BulkAI Server ──────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'pong':
      break;

    case 'prompt':
      // ChatGPT keyword generation
      console.log('[BulkAI] Nhận prompt [' + msg.id + ']: ' + (msg.content || '').substring(0, 60) + '...');
      forwardPromptToChatGPT(msg);
      break;

    case 'cancel_prompt':
      // Frontend yêu cầu hủy prompt đang xử lý
      console.log('[BulkAI] Cancel prompt request');
      sendCancelToChatGPT();
      break;

    case 'generate_flow':
      // Google Flow image generation
      console.log('[BulkAI] Nhận flow prompt [' + msg.id + ']');
      forwardToFlowTab(msg);
      break;

    default:
      console.log('[BulkAI] Message không xác định:', msg.type);
  }
}

async function sendCancelToChatGPT() {
  try {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
    if (tabs.length > 0) {
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'force_reset' });
    }
  } catch (_) {}
}

// ── Forward ChatGPT prompt ──────────────────────────────────────

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
      console.warn('[BulkAI] Không thể focus:', e.message);
    }

    // Kiểm tra content script
    let alive = false;
    let isBusy = false;
    try {
      const pong = await chrome.tabs.sendMessage(targetTab.id, { action: 'ping' });
      alive = pong && pong.alive;
      isBusy = pong && pong.isProcessing;
    } catch (_) {}

    // Nếu content script đang BUSY → force reset trước khi gửi prompt mới
    if (alive && isBusy) {
      console.log('[BulkAI] Content script đang BUSY, gửi force_reset...');
      try {
        await chrome.tabs.sendMessage(targetTab.id, { action: 'force_reset' });
        await new Promise(r => setTimeout(r, 500));
      } catch (_) {}
    }

    // Inject nếu chưa có
    if (!alive) {
      console.log('[BulkAI] Inject content.js vào ChatGPT...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content.js']
        });
        await new Promise(r => setTimeout(r, 800));
      } catch (injectErr) {
        console.error('[BulkAI] Inject lỗi:', injectErr.message);
        sendToServer({ type: 'error', id: promptData.id, error: 'Inject lỗi: ' + injectErr.message });
        return;
      }
    }

    // Gửi prompt — retry 3 lần
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 600 * i));
      try {
        const resp = await chrome.tabs.sendMessage(targetTab.id, {
          action: 'inject_prompt',
          id: promptData.id,
          content: promptData.content
        });
        console.log('[BulkAI] Đã gửi prompt tới ChatGPT (attempt ' + (i + 1) + ')');
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('[BulkAI] Lần ' + (i + 1) + ' thất bại:', err.message);
      }
    }

    if (lastErr) {
      sendToServer({ type: 'error', id: promptData.id, error: 'Lỗi gửi prompt: ' + lastErr.message });
    }

  } catch (e) {
    console.error('[BulkAI] forwardPromptToChatGPT lỗi:', e.message);
    sendToServer({ type: 'error', id: promptData.id, error: e.message });
  }
}

// ── Forward Google Flow prompt ──────────────────────────────────

function forwardToFlowTab(msg) {
  chrome.tabs.query({ url: FLOW_URLS }, (tabs) => {
    if (tabs.length === 0) {
      console.warn('[BulkAI] Không tìm thấy tab Google Flow!');
      sendToServer({
        type: 'flow_error',
        id: msg.id,
        error: 'Không tìm thấy tab Google Flow.'
      });
      return;
    }

    const tab = tabs.find(t => t.url && t.url.startsWith('https://flow.google.com/')) || tabs[0];
    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[BulkAI] Lỗi gửi tới Flow:', chrome.runtime.lastError.message);
        sendToServer({
          type: 'flow_error',
          id: msg.id,
          error: chrome.runtime.lastError.message
        });
      }
    });
  });
}

// ── Handle Messages from Content Scripts ────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ─── ChatGPT responses ───
  if (msg.action === 'chatgpt_response') {
    console.log('[BulkAI] ✅ Nhận response [' + msg.id + ']: ' + (msg.content || '').substring(0, 80) + '...');
    sendToServer({
      type: 'response',
      id: msg.id,
      content: msg.content,
      status: 'success'
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'chatgpt_error') {
    console.error('[BulkAI] ✗ Lỗi ChatGPT [' + msg.id + ']: ' + msg.error);
    sendToServer({
      type: 'error',
      id: msg.id,
      error: msg.error
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'chatgpt_streaming') {
    // Keepalive from content script during generation
    sendResponse({ ok: true });
    return true;
  }

  // ─── Google Flow responses ───
  if (msg.type === 'flow_result' || msg.type === 'flow_progress' || msg.type === 'flow_error') {
    sendToServer(msg);
  }

  sendResponse({ ok: true });
  return true;
});

// ── Auto-connect on startup ─────────────────────────────────────

connectWebSocket();
startKeepalive();

self.addEventListener('activate', () => {
  connectWebSocket();
});
