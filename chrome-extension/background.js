// ============================================================
// BulkAI Bridge - Background Service Worker (unified)
// Handles ChatGPT keyword generation + Google Flow image generation
// ============================================================

const CONFIG = {
  WS_URL: 'ws://127.0.0.1:8765',
  RECONNECT_DELAY: 2000,
  MAX_RECONNECT_DELAY: 5000, // Không bao giờ bỏ cuộc — app có thể bật Bridge bất cứ lúc nào
  HEARTBEAT_INTERVAL: 10000,
  CLOSE_CODE_BUSY: 4001,     // khớp closeCodeBusy trong pkg/bridge/bridge.go
  BUSY_RETRY_DELAY: 30000
};

const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const FLOW_URLS    = ['https://labs.google/*', 'https://flow.google.com/*'];

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let rejectedBusy = false; // app đã từ chối vì đang kết nối với extension khác
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

  try {
    console.log('[BulkAI] Đang kết nối WebSocket...');
    ws = new WebSocket(CONFIG.WS_URL);

    ws.onopen = () => {
      console.log('[BulkAI] ✅ Đã kết nối WebSocket tới BulkAI app');
      reconnectAttempts = 0;
      rejectedBusy = false;
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

    const thisWs = ws;
    ws.onclose = (event) => {
      console.log('[BulkAI] WebSocket đã đóng (code=' + event.code + ')');
      if (ws !== thisWs) return; // socket cũ (đã bị thay) — bỏ qua
      ws = null;
      stopHeartbeat();
      if (event.code === CONFIG.CLOSE_CODE_BUSY) {
        rejectedBusy = true;
        // App đã có extension khác kết nối (bản cài khác / profile Chrome khác) — chờ lâu rồi thử lại
        addLog('App dang ket noi voi extension khac — thu lai sau ' + (CONFIG.BUSY_RETRY_DELAY / 1000) + 's', 'warn');
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => connectWebSocket(), CONFIG.BUSY_RETRY_DELAY);
        return;
      }
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
  const delay = Math.min(CONFIG.RECONNECT_DELAY * reconnectAttempts, CONFIG.MAX_RECONNECT_DELAY);
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
      sendCancelToFlow();
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

async function sendCancelToFlow() {
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_URLS });
    for (const tab of tabs) {
      await chrome.tabs.sendMessage(tab.id, { action: 'force_reset' }).catch(() => {});
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

    // LUÔN re-inject content.js để đảm bảo version mới nhất
    // (content.js mới có __bulkaiCleanup guard nên an toàn khi inject lại)
    console.log('[BulkAI] Re-inject content.js vào ChatGPT...');
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

async function forwardToFlowTab(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_URLS });
    if (!tabs || tabs.length === 0) {
      console.warn('[BulkAI] Không tìm thấy tab Google Flow!');
      sendToServer({
        type: 'flow_error',
        id: msg.id,
        error: 'Không tìm thấy tab Google Flow. Vui lòng mở https://flow.google.com hoặc https://labs.google/fx/tools/flow.'
      });
      return;
    }

    const tab = tabs.find(t => t.url && t.url.includes('flow.google.com')) ||
                tabs.find(t => t.url && t.url.includes('labs.google/fx')) ||
                tabs[0];

    // Focus tab Google Flow để Chrome không throttle JS timers khi ở tab khác
    try {
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn('[BulkAI] Không thể focus tab Flow:', e.message);
    }

    // Đảm bảo content_flow.js đã được inject
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_flow.js']
      });
      await new Promise(r => setTimeout(r, 400));
    } catch (injectErr) {
      console.log('[BulkAI] Script already present or inject skipped:', injectErr.message);
    }

    // Gửi prompt có retry 3 lần
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 500 * i));
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
        console.log('[BulkAI] Đã gửi flow prompt tới tab (attempt ' + (i + 1) + ')');
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('[BulkAI] Lần ' + (i + 1) + ' gửi flow prompt thất bại:', err.message);
      }
    }

    if (lastErr) {
      sendToServer({
        type: 'flow_error',
        id: msg.id,
        error: 'Lỗi gửi tới Google Flow: ' + lastErr.message
      });
    }
  } catch (err) {
    sendToServer({
      type: 'flow_error',
      id: msg.id,
      error: 'Lỗi tab Flow: ' + err.message
    });
  }
}

// ── Trusted input via chrome.debugger ──────────────────────────

async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  try {
    await fn(send);
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}

async function trustedClick(send, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await new Promise(r => setTimeout(r, 60));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function trustedEnter(send) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

// ── Activity Log for Popup ──────────────────────────────────────

let activityLogs = [];
const MAX_LOGS = 50;

function addLog(message, type = 'info') {
  const now = new Date();
  const time = now.toLocaleTimeString('vi-VN', { hour12: false });
  activityLogs.unshift({ time, message, type });
  if (activityLogs.length > MAX_LOGS) activityLogs.pop();
  console.log(`[BulkAI] [${type}] ${message}`);
}

// ── Handle Messages from Content Scripts + Popup ────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ─── Popup API ───
  if (msg.action === 'get_status') {
    sendResponse({
      isConnected: ws && ws.readyState === WebSocket.OPEN,
      isListening: true,
      wsUrl: CONFIG.WS_URL,
      reconnectAttempts: reconnectAttempts,
      rejectedBusy: rejectedBusy
    });
    return true;
  }

  if (msg.action === 'get_logs') {
    sendResponse(activityLogs);
    return true;
  }

  if (msg.action === 'toggle_listening') {
    if (msg.value) {
      connectWebSocket();
      addLog('Bat che do lang nghe', 'info');
    } else {
      if (ws) { ws.close(); ws = null; }
      addLog('Tat che do lang nghe', 'info');
    }
    sendResponse({
      isConnected: ws && ws.readyState === WebSocket.OPEN,
      isListening: msg.value,
      wsUrl: CONFIG.WS_URL,
      reconnectAttempts: reconnectAttempts,
      rejectedBusy: rejectedBusy
    });
    return true;
  }

  if (msg.action === 'update_ws_url') {
    CONFIG.WS_URL = msg.url;
    addLog('Cap nhat WS URL: ' + msg.url, 'info');
    if (ws) { ws.close(); }
    connectWebSocket();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'clear_logs') {
    activityLogs = [];
    sendResponse({ ok: true });
    return true;
  }

  // ─── ChatGPT responses ───
  if (msg.action === 'chatgpt_response') {
    addLog('Nhan response [' + msg.id + ']: ' + (msg.content || '').substring(0, 60) + '...', 'success');
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
    addLog('Loi ChatGPT [' + msg.id + ']: ' + msg.error, 'error');
    sendToServer({
      type: 'error',
      id: msg.id,
      error: msg.error
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'chatgpt_streaming') {
    sendResponse({ ok: true });
    return true;
  }

  // ─── Google Flow: trusted input (isTrusted=true) qua chrome.debugger ───
  // Dùng khi JS click() không kích hoạt được nút Generate của Flow
  if (msg.action === 'flow_trusted_click' || msg.action === 'flow_trusted_enter') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return true; }
    const run = msg.action === 'flow_trusted_click'
      ? (send) => trustedClick(send, msg.x, msg.y)
      : (send) => trustedEnter(send);
    withDebugger(tabId, run)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
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
addLog('Extension khoi dong', 'info');

self.addEventListener('activate', () => {
  connectWebSocket();
});
