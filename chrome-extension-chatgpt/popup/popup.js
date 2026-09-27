// BulkAI ChatGPT Bridge — Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const listeningToggle = document.getElementById('listeningToggle');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const wsUrlInput = document.getElementById('wsUrl');
  const saveUrlBtn = document.getElementById('saveUrlBtn');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const logContainer = document.getElementById('logContainer');

  // ─── Load initial state ──────────────────────────────

  async function loadStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ action: 'get_status' });
      updateStatusUI(status);
    } catch (e) {
      console.error('Lỗi lấy trạng thái:', e);
    }
  }

  function updateStatusUI(status) {
    if (!status) return;

    listeningToggle.checked = status.isListening;
    wsUrlInput.value = status.wsUrl || 'ws://localhost:8765';

    // Update status badge
    statusBadge.className = 'status-badge';
    if (status.isConnected) {
      statusBadge.classList.add('connected');
      statusText.textContent = 'Đã kết nối';
    } else if (status.isListening) {
      statusBadge.classList.add('waiting');
      statusText.textContent = status.reconnectAttempts > 0
        ? `Đang kết nối lại (${status.reconnectAttempts})...`
        : 'Đang chờ kết nối...';
    } else {
      statusBadge.classList.add('disconnected');
      statusText.textContent = 'Chưa kết nối';
    }
  }

  // ─── Load logs ───────────────────────────────────────

  async function loadLogs() {
    try {
      const logs = await chrome.runtime.sendMessage({ action: 'get_logs' });
      renderLogs(logs || []);
    } catch (e) {
      console.error('Lỗi load logs:', e);
    }
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logContainer.innerHTML = '<div class="log-empty">Chưa có hoạt động nào</div>';
      return;
    }

    logContainer.innerHTML = logs.map(log => `
      <div class="log-entry ${log.type || 'info'}">
        <span class="log-time">${log.time}</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
      </div>
    `).join('');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Event Listeners ─────────────────────────────────

  listeningToggle.addEventListener('change', async () => {
    const value = listeningToggle.checked;
    try {
      const status = await chrome.runtime.sendMessage({
        action: 'toggle_listening',
        value
      });
      updateStatusUI(status);
      // Reload logs after a small delay
      setTimeout(loadLogs, 500);
    } catch (e) {
      console.error('Lỗi toggle listening:', e);
    }
  });

  saveUrlBtn.addEventListener('click', async () => {
    const url = wsUrlInput.value.trim();
    if (!url) return;

    try {
      await chrome.runtime.sendMessage({
        action: 'update_ws_url',
        url
      });
      saveUrlBtn.textContent = '✓';
      setTimeout(() => { saveUrlBtn.textContent = 'Lưu'; }, 1500);
    } catch (e) {
      console.error('Lỗi lưu URL:', e);
    }
  });

  clearLogsBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'clear_logs' });
      renderLogs([]);
    } catch (e) {
      console.error('Lỗi xóa logs:', e);
    }
  });

  // ─── Listen for status updates from background ──────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'status_update') {
      updateStatusUI(message);
      loadLogs();
    }
  });

  // ─── Periodic refresh ────────────────────────────────

  setInterval(() => {
    loadStatus();
    loadLogs();
  }, 3000);

  // ─── Initial load ────────────────────────────────────

  await loadStatus();
  await loadLogs();
});
