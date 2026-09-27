// BulkAI ChatGPT Bridge â€” Service Worker (Background Script)
// Manages WebSocket connection to BulkAI PC App and routes messages to/from content script

const CONFIG = {
  WS_URL: 'ws://127.0.0.1:8765',
  HEARTBEAT_INTERVAL: 10000,
  RECONNECT_INTERVAL: 5000,
  MAX_RECONNECT_ATTEMPTS: 50,
  STORAGE_KEYS: {
    LISTENING: 'bulkai_listening',
    WS_URL: 'bulkai_ws_url',
    LOGS: 'bulkai_logs',
    MAX_LOGS: 100
  }
};

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isListening = false;
let currentWsUrl = CONFIG.WS_URL;
let pendingMessages = []; // Buffer khi SW bá»‹ terminate trong lÃºc ChatGPT Ä‘ang generate

// â”€â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function addLog(message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('vi-VN'),
    message,
    type
  };
  console.log(`[BulkAI Bridge] [${type}] ${message}`);

  try {
    const result = await chrome.storage.local.get(CONFIG.STORAGE_KEYS.LOGS);
    let logs = result[CONFIG.STORAGE_KEYS.LOGS] || [];
    logs.unshift(entry);
    if (logs.length > CONFIG.MAX_LOGS) {  // Fix: was CONFIG.STORAGE_KEYS.MAX_LOGS (undefined)
      logs = logs.slice(0, CONFIG.MAX_LOGS);
    }
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LOGS]: logs });
  } catch (e) {
    // Storage might not be available
  }
}

// â”€â”€â”€ WebSocket Connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Validate URL trÆ°á»›c khi káº¿t ná»‘i
  if (!currentWsUrl || !/^wss?:\/\/.+/.test(currentWsUrl)) {
    addLog(`URL WebSocket khÃ´ng há»£p lá»‡: "${currentWsUrl}". Pháº£i báº¯t Ä‘áº§u báº±ng ws:// hoáº·c wss://`, 'error');
    isListening = false;
    chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LISTENING]: false });
    broadcastStatus();
    return;
  }

  try {
    addLog(`Äang káº¿t ná»‘i tá»›i: ${currentWsUrl}`, 'info');
    ws = new WebSocket(currentWsUrl);

    ws.onopen = () => {
      reconnectAttempts = 0;
      addLog(`ÄÃ£ káº¿t ná»‘i tá»›i BulkAI: ${currentWsUrl}`, 'success');
      startHeartbeat();
      startKeepaliveAlarm();
      broadcastStatus();

      // â”€â”€ Flush pending messages buffered khi SW bá»‹ kill â”€â”€
      if (pendingMessages.length > 0) {
        addLog(`Gá»­i ${pendingMessages.length} message Ä‘ang chá»...`, 'info');
        const toFlush = [...pendingMessages];
        pendingMessages = [];
        for (const msg of toFlush) {
          try {
            ws.send(JSON.stringify(msg));
          } catch (e) {
            addLog(`Lá»—i flush pending message: ${e.message}`, 'error');
          }
        }
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        addLog(`Lá»—i parse message: ${e.message}`, 'error');
      }
    };

    ws.onclose = (event) => {
      // code 1000 = Ä‘Ã³ng bÃ¬nh thÆ°á»ng, cÃ²n láº¡i lÃ  lá»—i
      const isNormal = event.code === 1000;
      addLog(
        `WebSocket Ä‘Ã³ng káº¿t ná»‘i (code: ${event.code}${event.reason ? ', reason: ' + event.reason : ''})`,
        isNormal ? 'info' : 'warning'
      );
      stopHeartbeat();
      stopKeepaliveAlarm();
      ws = null;
      broadcastStatus();

      // Auto-reconnect if still listening
      if (isListening) {
        scheduleReconnect();
      }
    };

    ws.onerror = (error) => {
      // WebSocket API khÃ´ng cung cáº¥p message lá»—i chi tiáº¿t vÃ¬ lÃ½ do báº£o máº­t,
      // nhÆ°ng readyState giÃºp cháº©n Ä‘oÃ¡n váº¥n Ä‘á»
      const state = ws ? ws.readyState : 'N/A';
      const stateLabel = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' }[state] || state;
      addLog(
        `Lá»—i WebSocket (readyState: ${stateLabel}) â€” Kiá»ƒm tra BulkAI App cÃ³ Ä‘ang cháº¡y táº¡i ${currentWsUrl} khÃ´ng.`,
        'error'
      );
    };

  } catch (e) {
    addLog(`KhÃ´ng thá»ƒ khá»Ÿi táº¡o WebSocket tá»›i ${currentWsUrl}: ${e.message}`, 'error');
    if (isListening) {
      scheduleReconnect();
    }
  }
}

function disconnectWebSocket() {
  stopHeartbeat();
  clearReconnectTimer();
  if (ws) {
    ws.close(1000, 'User stopped listening');
    ws = null;
  }
  broadcastStatus();
}

function scheduleReconnect() {
  clearReconnectTimer();
  if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    addLog('ÄÃ£ vÆ°á»£t quÃ¡ sá»‘ láº§n káº¿t ná»‘i láº¡i tá»‘i Ä‘a. Dá»«ng láº¯ng nghe.', 'error');
    isListening = false;
    chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LISTENING]: false });
    broadcastStatus();
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(CONFIG.RECONNECT_INTERVAL * reconnectAttempts, 30000);
  addLog(`Káº¿t ná»‘i láº¡i sau ${delay / 1000}s (láº§n ${reconnectAttempts})...`, 'info');

  reconnectTimer = setTimeout(() => {
    if (isListening) {
      connectWebSocket();
    }
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// â”€â”€â”€ Heartbeat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Keepalive Alarm (prevents SW suspension) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function startKeepaliveAlarm() {
  chrome.alarms.create('bulkai_keepalive', { periodInMinutes: 0.3 }); // ~18s
}

function stopKeepaliveAlarm() {
  chrome.alarms.clear('bulkai_keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bulkai_keepalive') {
    // Just accessing ws keeps the SW alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Connection still alive, SW stays active
    } else if (isListening) {
      // Connection lost, try reconnect
      connectWebSocket();
    }
  }
});

// â”€â”€â”€ Message Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleMessage(data) {
  switch (data.type) {
    case 'pong':
      // Heartbeat response - connection is alive
      break;

    case 'prompt':
      addLog(`Nháº­n prompt [${data.id}]: ${data.content.substring(0, 80)}...`, 'info');
      await forwardPromptToContentScript(data);
      break;

    case 'generate_flow':
      addLog(`Nháº­n flow prompt [${data.id}]: ${(data.prompt || '').substring(0, 60)}...`, 'info');
      await forwardFlowToContentScript(data);
      break;

    case 'select_model':
      addLog(`Chuyá»ƒn model ChatGPT: ${data.model}`, 'info');
      await forwardToContentScript({
        action: 'select_model',
        model: data.model
      });
      break;

    default:
      addLog(`Message khÃ´ng xÃ¡c Ä‘á»‹nh: ${data.type}`, 'warning');
  }
}

async function forceBringChromeToFront(windowId, tabId) {
  // â”€â”€ Minimize â†’ Restore trick â”€â”€
  // On Windows, SetForegroundWindow() is BLOCKED for "focus stealing".
  // BUT ShowWindow(SW_RESTORE) from minimized state ALWAYS activates the window,
  // because it's treated as a window state change, not a focus steal.
  // This trick works EVERY TIME, unlike chrome.windows.update({focused:true}).
  try {
    const win = await chrome.windows.get(windowId);
    const originalState = win.state; // 'normal', 'maximized', 'minimized', 'fullscreen'

    // Náº¿u cá»­a sá»• Chrome Ä‘Ã£ cÃ³ focus thÃ¬ chá»‰ cáº§n chuyá»ƒn sang tab ChatGPT
    if (win.focused) {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    }
    if (originalState !== 'minimized') {
      await chrome.windows.update(windowId, { state: 'minimized' });
      await new Promise(r => setTimeout(r, 200));
    }

    // Step 2: Restore to original state â€” this ALWAYS activates the window!
    // Windows calls ShowWindow(SW_RESTORE) which bypasses focus restrictions.
    const targetState = (originalState === 'minimized') ? 'normal' : originalState;
    await chrome.windows.update(windowId, { state: targetState, focused: true });
    await new Promise(r => setTimeout(r, 300));

    // Step 3: Activate the ChatGPT tab
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 300));

    addLog('ÄÃ£ focus Chrome (minimizeâ†’restore)', 'success');
    return true;
  } catch (e) {
    addLog(`Lá»—i focus: ${e.message}`, 'warning');

    // Fallback: best-effort direct focus
    try {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 300));
    } catch (e2) { /* ignore */ }

    return false;
  }
}

async function forwardPromptToContentScript(promptData) {
  try {
    // Find the ChatGPT tab
    let tabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });

    // Náº¿u chÆ°a má»Ÿ tab ChatGPT, tá»± Ä‘á»™ng má»Ÿ tab má»›i luÃ´n
    if (tabs.length === 0) {
      addLog('ChÆ°a cÃ³ tab ChatGPT, Ä‘ang tá»± Ä‘á»™ng má»Ÿ tab https://chatgpt.com...', 'info');
      const newTab = await chrome.tabs.create({
        url: 'https://chatgpt.com',
        active: true
      });
      // Äá»£i tab táº£i xong (tá»‘i Ä‘a 6s)
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 6000);
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await new Promise(r => setTimeout(r, 1500));
      tabs = [newTab];
    }

    const targetTab = tabs.find(t => t.active) || tabs[0];
    
    // Náº¿u tab Ä‘ang bá»‹ Chrome Ä‘Æ°a vÃ o cháº¿ Ä‘á»™ ngá»§ (discarded), Ä‘Ã¡nh thá»©c dáº­y
    if (targetTab.discarded) {
      addLog(`Tab ChatGPT Ä‘ang á»Ÿ cháº¿ Ä‘á»™ ngá»§ (discarded), Ä‘ang reload...`, 'warning');
      await chrome.tabs.reload(targetTab.id);
      await new Promise(r => setTimeout(r, 2000));
    }

    addLog(`Gá»­i prompt tá»›i tab ChatGPT (id: ${targetTab.id}, url: ${targetTab.url || 'chatgpt'})...`, 'info');

    // â”€â”€ CRITICAL: Force Chrome to foreground before injection â”€â”€
    const focusSuccess = await forceBringChromeToFront(targetTab.windowId, targetTab.id);
    if (!focusSuccess) {
      addLog('KhÃ´ng thá»ƒ focus Chrome, sáº½ thá»­ inject báº±ng main-world script...', 'warning');
    }

    // â”€â”€ Step 1: Ping content script to check if it's alive â”€â”€
    let contentScriptAlive = false;
    try {
      const pong = await chrome.tabs.sendMessage(targetTab.id, { action: 'ping' });
      contentScriptAlive = pong && pong.alive;
    } catch (_) {
      // Not alive â€” will inject below
    }

    // â”€â”€ Step 2: Inject if not alive â”€â”€
    if (!contentScriptAlive) {
      addLog('Content script chÆ°a sáºµn sÃ ng, Ä‘ang inject...', 'warning');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content.js']
        });
        addLog('ÄÃ£ inject content script thÃ nh cÃ´ng', 'success');
        await new Promise(r => setTimeout(r, 400));
      } catch (injectErr) {
        const errorMsg = `KhÃ´ng thá»ƒ inject content script: ${injectErr.message}. HÃ£y thá»­ reload trang ChatGPT.`;
        addLog(errorMsg, 'error');
        sendToBulkAI({
          type: 'error',
          id: promptData.id,
          error: errorMsg,
          code: 'INJECT_ERROR'
        });
        return;
      }
    }

    // â”€â”€ Step 3: Send prompt with exponential backoff retry â”€â”€
    // Gives content script time to initialize after injection (or recover from busy state)
    const MAX_RETRIES = 4;
    const BASE_DELAY = 600; // ms
    let lastErr = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1); // 600, 1200, 2400ms
        addLog(`Thá»­ láº¡i láº§n ${attempt}/${MAX_RETRIES - 1} sau ${delay}ms...`, 'info');
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const response = await chrome.tabs.sendMessage(targetTab.id, {
          action: 'inject_prompt',
          id: promptData.id,
          content: promptData.content
        });
        addLog(`Content script pháº£n há»“i (láº§n ${attempt + 1}): ${JSON.stringify(response)}`, 'success');
        lastErr = null;
        break; // success â€” stop retrying
      } catch (err) {
        lastErr = err;
        addLog(`Láº§n ${attempt + 1} tháº¥t báº¡i: ${err.message}`, 'warning');
      }
    }

    if (lastErr) {
      const errorMsg = `KhÃ´ng thá»ƒ liÃªn láº¡c content script sau ${MAX_RETRIES} láº§n thá»­: ${lastErr.message}. HÃ£y reload trang ChatGPT.`;
      addLog(errorMsg, 'error');
      sendToBulkAI({
        type: 'error',
        id: promptData.id,
        error: errorMsg,
        code: 'INJECT_ERROR'
      });
    }

  } catch (e) {
    addLog(`Lá»—i gá»­i prompt tá»›i content script: ${e.message}`, 'error');
    sendToBulkAI({
      type: 'error',
      id: promptData.id,
      error: e.message,
      code: 'FORWARD_ERROR'
    });
  }
}

async function forwardToContentScript(data) {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, data);
    }
  } catch (e) {
    addLog(`Lá»—i gá»­i tá»›i content script: ${e.message}`, 'error');
  }
}

// â”€â”€â”€ Google Flow: Forward to labs.google tab â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function forwardFlowToContentScript(flowData) {
  try {
    let tabs = await chrome.tabs.query({
      url: ['https://labs.google/*', 'https://flow.google.com/*']
    });

    // Nếu chưa có tab Flow, tự động mở tab mới (giống ChatGPT)
    if (tabs.length === 0) {
      const openUrl = flowData.flowUrl || 'https://labs.google/flow/';
      addLog(`Chưa có tab Google Flow, đang tự động mở: ${openUrl}`, 'info');
      sendToBulkAI({
        type: 'flow_progress',
        id: flowData.id,
        status: 'opening',
        message: `Đang mở Google Flow: ${openUrl}`
      });

      const newTab = await chrome.tabs.create({ url: openUrl, active: true });

      // Đợi tab load xong (tối đa 15s)
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15000);
        const listener = (tabId, info) => {
          if (tabId === newTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      // Đợi thêm để trang render xong
      await new Promise(r => setTimeout(r, 3000));
      addLog('Tab Google Flow đã mở xong', 'success');
      tabs = [newTab];
    }

    const targetTab = tabs[0];
    addLog(`Gá»­i flow prompt tá»›i tab labs.google (id: ${targetTab.id})...`, 'info');

    // Focus tab
    try {
      await forceBringChromeToFront(targetTab.windowId, targetTab.id);
    } catch (e) {
      addLog(`KhÃ´ng thá»ƒ focus tab: ${e.message}`, 'warning');
    }

    // Check content script alive
    let contentScriptAlive = false;
    try {
      const pong = await chrome.tabs.sendMessage(targetTab.id, { action: 'ping' });
      contentScriptAlive = pong && pong.alive;
    } catch (_) {}

    // Inject if needed
    if (!contentScriptAlive) {
      addLog('Flow content script chÆ°a sáºµn sÃ ng, Ä‘ang inject...', 'warning');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content_flow.js']
        });
        addLog('ÄÃ£ inject content_flow.js thÃ nh cÃ´ng', 'success');
        await new Promise(r => setTimeout(r, 1000));
      } catch (injectErr) {
        sendToBulkAI({
          type: 'flow_error',
          id: flowData.id,
          error: `KhÃ´ng thá»ƒ inject: ${injectErr.message}`
        });
        return;
      }
    }

    // Send to content script
    try {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'generate_flow',
        id: flowData.id,
        prompt: flowData.prompt,
        flowUrl: flowData.flowUrl
      });
      addLog('ÄÃ£ gá»­i flow prompt tá»›i content script', 'success');
    } catch (err) {
      sendToBulkAI({
        type: 'flow_error',
        id: flowData.id,
        error: `Lá»—i gá»­i tá»›i content script: ${err.message}`
      });
    }
  } catch (e) {
    addLog(`Lá»—i flow: ${e.message}`, 'error');
    sendToBulkAI({
      type: 'flow_error',
      id: flowData.id,
      error: e.message
    });
  }
}

function sendToBulkAI(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return;
  }

  // WS chÆ°a má»Ÿ (SW bá»‹ terminate trong lÃºc ChatGPT generate)
  // â†’ Buffer láº¡i vÃ  reconnect ngay, flush khi onopen
  addLog(
    `WS chÆ°a káº¿t ná»‘i â€” buffer message type="${data.type}" vÃ  reconnect...`,
    'warning'
  );
  pendingMessages.push(data);

  // Giá»›i háº¡n buffer Ä‘á»ƒ trÃ¡nh memory leak
  if (pendingMessages.length > 20) {
    pendingMessages.shift(); // bá» message cÅ© nháº¥t
  }

  // KÃ­ch hoáº¡t reconnect náº¿u Ä‘ang á»Ÿ cháº¿ Ä‘á»™ láº¯ng nghe
  if (isListening) {
    connectWebSocket();
  } else {
    // SW vá»«a restart, restore state tá»« storage rá»“i reconnect
    initFromStorage();
  }
}

// â”€â”€â”€ Focus Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function minimizeChromeWindow() {
  // Minimize Chrome to return focus to the previously active app.
  // On Windows, minimizing Chrome causes the OS to activate the next 
  // window in the Z-order (previously focused app).
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    if (tabs.length > 0) {
      await chrome.windows.update(tabs[0].windowId, { state: 'minimized' });
      addLog('ÄÃ£ minimize Chrome, tráº£ focus cho app', 'info');
    }
  } catch (e) {
    // Non-critical, ignore silently
  }
}

// â”€â”€â”€ Status Broadcasting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function broadcastStatus() {
  const status = getStatus();
  // Notify popup if open
  chrome.runtime.sendMessage({
    action: 'status_update',
    ...status
  }).catch(() => { /* Popup not open */ });
}

function getStatus() {
  return {
    isListening,
    isConnected: ws !== null && ws.readyState === WebSocket.OPEN,
    wsUrl: currentWsUrl,
    reconnectAttempts
  };
}

// â”€â”€â”€ Message Listener (from popup & content script) â”€â”€â”€â”€â”€â”€â”€â”€

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'get_status':
      sendResponse(getStatus());
      return true;

    case 'toggle_listening':
      isListening = message.value;
      chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LISTENING]: isListening });

      if (isListening) {
        addLog('Báº­t cháº¿ Ä‘á»™ láº¯ng nghe', 'success');
        reconnectAttempts = 0;
        connectWebSocket();
      } else {
        addLog('Táº¯t cháº¿ Ä‘á»™ láº¯ng nghe', 'info');
        disconnectWebSocket();
      }
      sendResponse(getStatus());
      return true;

    case 'update_ws_url':
      currentWsUrl = message.url || CONFIG.WS_URL;
      chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.WS_URL]: currentWsUrl });
      addLog(`ÄÃ£ cáº­p nháº­t URL: ${currentWsUrl}`, 'info');

      // Reconnect with new URL if currently listening
      if (isListening) {
        disconnectWebSocket();
        setTimeout(() => connectWebSocket(), 500);
      }
      sendResponse({ success: true });
      return true;

    case 'chatgpt_response':
      // Response from content script
      addLog(`Nháº­n response [${message.id}]: ${message.content.substring(0, 80)}...`, 'success');
      sendToBulkAI({
        type: 'response',
        id: message.id,
        content: message.content,
        status: 'success',
        timestamp: Date.now()
      });
      // Minimize Chrome to return focus to the BulkAI app
      minimizeChromeWindow();
      return true;

    case 'chatgpt_error':
      // Error from content script
      addLog(`Lá»—i ChatGPT [${message.id}]: ${message.error}`, 'error');
      sendToBulkAI({
        type: 'error',
        id: message.id,
        error: message.error,
        code: message.code || 'CONTENT_SCRIPT_ERROR',
        timestamp: Date.now()
      });
      // Minimize Chrome to return focus to the BulkAI app
      minimizeChromeWindow();
      return true;

    case 'chatgpt_streaming':
      // Streaming status from content script â€” keep service worker alive
      break;

    // â”€â”€â”€ Google Flow responses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'flow_result':
      addLog(`Flow result [${message.id}]: ${message.images?.length || 0} áº£nh`, 'success');
      sendToBulkAI({
        type: 'flow_result',
        id: message.id,
        prompt: message.prompt,
        images: message.images
      });
      break;

    case 'flow_progress':
      addLog(`Flow progress [${message.id}]: ${message.message}`, 'info');
      sendToBulkAI({
        type: 'flow_progress',
        id: message.id,
        status: message.status,
        message: message.message
      });
      break;

    case 'flow_error':
      addLog(`Flow error [${message.id}]: ${message.error}`, 'error');
      sendToBulkAI({
        type: 'flow_error',
        id: message.id,
        error: message.error
      });
      break;

    case 'debugger_click':
      // Click at specific coordinates via Chrome Debugger API
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Google Flow tab found' });
            return;
          }
          const tabId = sender.tab?.id || tabs[0].id;
          const x = message.x;
          const y = message.y;
          
          addLog(`Debugger: clicking at (${Math.round(x)}, ${Math.round(y)})`, 'info');
          
          // Attach debugger
          await chrome.debugger.attach({ tabId }, '1.3');
          
          // Mouse down
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
          });
          await new Promise(r => setTimeout(r, 50));
          
          // Mouse up
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
          });
          
          // Detach
          try { await chrome.debugger.detach({ tabId }); } catch (_) {}
          
          addLog('Debugger: click completed', 'success');
          sendResponse({ success: true });
        } catch (e) {
          addLog(`Debugger click error: ${e.message}`, 'error');
          try {
            const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
            if (tabs.length > 0) await chrome.debugger.detach({ tabId: tabs[0].id });
          } catch (_) {}
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'debugger_type_text':
      // Use Chrome Debugger API to simulate native keyboard input
      // This is the ONLY way to trigger Google Flow's Lexical editor
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Google Flow tab found' });
            return;
          }
          const tabId = sender.tab?.id || tabs[0].id;
          const prompt = message.prompt;
          
          addLog(`Debugger: typing prompt on tab ${tabId} (${prompt.substring(0, 40)}...)`, 'info');
          
          // Attach debugger
          await chrome.debugger.attach({ tabId }, '1.3');
          addLog('Debugger attached', 'info');
          
          // Focus tab
          await chrome.tabs.update(tabId, { active: true });
          await new Promise(r => setTimeout(r, 300));
          
          // Click on textbox to focus it (use DOM.focus)
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `
              const tb = document.querySelector('[role="textbox"]') || document.querySelector('[contenteditable="true"]');
              if (tb) { tb.focus(); tb.click(); }
            `
          });
          await new Promise(r => setTimeout(r, 500));
          
          // Select all (Ctrl+A)
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
          });
          await new Promise(r => setTimeout(r, 200));
          
          // Delete selected
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
          });
          await new Promise(r => setTimeout(r, 300));
          
          // Type the prompt using Input.insertText (fastest native method)
          await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', {
            text: prompt
          });
          
          addLog('Debugger: text inserted via Input.insertText', 'success');
          await new Promise(r => setTimeout(r, 1000));
          
          // Detach debugger
          try {
            await chrome.debugger.detach({ tabId });
          } catch (e) {
            // Ignore detach errors
          }
          
          addLog('Debugger: done, detached', 'success');
          sendResponse({ success: true });
        } catch (e) {
          addLog(`Debugger error: ${e.message}`, 'error');
          // Try to detach on error
          try {
            const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
            if (tabs.length > 0) {
              await chrome.debugger.detach({ tabId: tabs[0].id });
            }
          } catch (_) {}
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async sendResponse

    case 'debugger_press_enter':
      // Press Enter via Chrome Debugger API
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
          if (tabs.length === 0) {
            sendResponse({ success: false });
            return;
          }
          const tabId = sender.tab?.id || tabs[0].id;
          
          await chrome.debugger.attach({ tabId }, '1.3');
          
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
          });
          await new Promise(r => setTimeout(r, 100));
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
          });
          
          try { await chrome.debugger.detach({ tabId }); } catch (_) {}
          
          addLog('Debugger: Enter pressed', 'success');
          sendResponse({ success: true });
        } catch (e) {
          addLog(`Debugger Enter error: ${e.message}`, 'error');
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'inject_flow_prompt':
      // Content script requests MAIN world injection
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://labs.google/*', 'https://flow.google.com/*'] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Google Flow tab found' });
            return;
          }
          const tabId = sender.tab?.id || tabs[0].id;
          const prompt = message.prompt;
          const selector = message.selector || '[role="textbox"]';
          
          addLog(`Injecting prompt in MAIN world (tab ${tabId})...`, 'info');
          
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: (sel, promptText) => {
              const input = document.querySelector(sel);
              if (!input) return false;
              
              // Focus + click to activate editor
              input.focus();
              input.click();
              
              // Clear existing content
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              
              // Wait then insert
              return new Promise(resolve => {
                setTimeout(() => {
                  input.focus();
                  
                  // Method 1: execCommand insertText
                  let result = document.execCommand('insertText', false, promptText);
                  
                  if (!result || input.textContent.trim().length < 5) {
                    // Method 2: Clipboard paste
                    const dt = new DataTransfer();
                    dt.setData('text/plain', promptText);
                    const pasteEvt = new ClipboardEvent('paste', {
                      bubbles: true,
                      cancelable: true,
                      clipboardData: dt
                    });
                    input.dispatchEvent(pasteEvt);
                  }
                  
                  // Method 3: Direct DOM + InputEvent fallback
                  setTimeout(() => {
                    if (input.textContent.trim().length < 5) {
                      let p = input.querySelector('p');
                      if (!p) {
                        p = document.createElement('p');
                        input.innerHTML = '';
                        input.appendChild(p);
                      }
                      p.textContent = promptText;
                      
                      input.dispatchEvent(new InputEvent('beforeinput', {
                        bubbles: true, cancelable: true, 
                        inputType: 'insertText', data: promptText
                      }));
                      input.dispatchEvent(new InputEvent('input', {
                        bubbles: true, inputType: 'insertText', data: promptText
                      }));
                    }
                    resolve(true);
                  }, 500);
                }, 300);
              });
            },
            args: [selector, prompt]
          });
          
          addLog('MAIN world injection completed', 'success');
          sendResponse({ success: true });
        } catch (e) {
          addLog(`MAIN world injection error: ${e.message}`, 'error');
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async sendResponse

    case 'get_logs':
      chrome.storage.local.get(CONFIG.STORAGE_KEYS.LOGS).then(result => {
        sendResponse(result[CONFIG.STORAGE_KEYS.LOGS] || []);
      });
      return true;

    case 'clear_logs':
      chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.LOGS]: [] });
      sendResponse({ success: true });
      return true;
  }
});

// â”€â”€â”€ Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

chrome.runtime.onStartup.addListener(() => {
  initFromStorage();
});

chrome.runtime.onInstalled.addListener(() => {
  addLog('BulkAI ChatGPT Bridge Ä‘Ã£ Ä‘Æ°á»£c cÃ i Ä‘áº·t', 'success');
  initFromStorage();
});

async function initFromStorage() {
  try {
    const result = await chrome.storage.local.get([
      CONFIG.STORAGE_KEYS.LISTENING,
      CONFIG.STORAGE_KEYS.WS_URL
    ]);

    currentWsUrl = result[CONFIG.STORAGE_KEYS.WS_URL] || CONFIG.WS_URL;
    isListening = result[CONFIG.STORAGE_KEYS.LISTENING] || false;

    if (isListening) {
      addLog('KhÃ´i phá»¥c cháº¿ Ä‘á»™ láº¯ng nghe...', 'info');
      connectWebSocket();
    }
  } catch (e) {
    addLog(`Lá»—i khá»Ÿi táº¡o: ${e.message}`, 'error');
  }
}

