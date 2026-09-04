// ============================================================
// BulkAI Google Flow Bridge - Background Service Worker
// Kết nối WebSocket với BulkAI app ↔ Content Script trên labs.google / flow.google.com
// ============================================================

const WS_URL = 'ws://localhost:8765';
let ws = null;
let reconnectTimer = null;
const RECONNECT_DELAY = 3000;

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

// ── Handle Messages from Content Script ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward kết quả từ content script về server
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
