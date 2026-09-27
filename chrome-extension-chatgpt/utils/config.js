// BulkAI ChatGPT Bridge - Configuration Constants

export const CONFIG = {
  // WebSocket server URL (BulkAI Go backend)
  WS_URL: 'ws://127.0.0.1:8765',

  // Heartbeat interval to keep service worker alive (ms)
  HEARTBEAT_INTERVAL: 20000,

  // Max time to wait for ChatGPT response (ms) - 3 minutes
  RESPONSE_TIMEOUT: 180000,

  // Debounce delay for MutationObserver (ms)
  // If DOM stops changing for this duration, consider response complete
  DEBOUNCE_DELAY: 3000,

  // WebSocket reconnect interval (ms)
  RECONNECT_INTERVAL: 5000,

  // Max reconnect attempts before giving up
  MAX_RECONNECT_ATTEMPTS: 50,

  // Storage keys
  STORAGE_KEYS: {
    LISTENING: 'bulkai_listening',
    WS_URL: 'bulkai_ws_url',
    LOGS: 'bulkai_logs',
    MAX_LOGS: 100
  }
};
