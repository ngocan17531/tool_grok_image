package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// FlowResult chứa kết quả từ Google Flow extension
type FlowResult struct {
	ID     string
	Prompt string
	Images []FlowImage
	Error  string
}

// FlowImage chứa thông tin ảnh từ extension
type FlowImage struct {
	URL    string `json:"url"`
	Base64 string `json:"base64"`
	Index  int    `json:"index"`
}

// Bridge quản lý WebSocket server để kết nối với Chrome Extension
type Bridge struct {
	mu              sync.Mutex
	running         bool
	server          *http.Server
	conn            *websocket.Conn
	onStatusChange  func(bridgeRunning bool, extensionConnected bool)
	onResponse      func(id string, content string, status string)
	onFlowProgress  func(id string, status string, message string)
	flowResultCh    chan FlowResult
	stopCh          chan struct{}
	port            int
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// New tạo Bridge mới
func New() *Bridge {
	return &Bridge{
		port: 8765,
	}
}

// SetOnStatusChange đặt callback khi trạng thái thay đổi
func (b *Bridge) SetOnStatusChange(fn func(bridgeRunning bool, extensionConnected bool)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onStatusChange = fn
}

// SetOnResponse đặt callback khi nhận response từ ChatGPT
func (b *Bridge) SetOnResponse(fn func(id string, content string, status string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onResponse = fn
}

// SetOnFlowProgress đặt callback khi nhận progress từ Google Flow
func (b *Bridge) SetOnFlowProgress(fn func(id string, status string, message string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onFlowProgress = fn
}

// SendFlowPrompt gửi prompt tới extension để generate ảnh trên Google Flow
func (b *Bridge) SendFlowPrompt(id string, prompt string, flowURL string) error {
	b.mu.Lock()
	conn := b.conn
	b.mu.Unlock()

	if conn == nil {
		return fmt.Errorf("extension chưa kết nối")
	}

	msg := map[string]interface{}{
		"type":    "generate_flow",
		"id":      id,
		"prompt":  prompt,
		"flowUrl": flowURL,
	}
	log.Printf("Bridge: Gửi flow prompt [%s]: %s", id, truncate(prompt, 60))
	return conn.WriteJSON(msg)
}

// WaitForFlowResult chờ kết quả từ Google Flow extension
func (b *Bridge) WaitForFlowResult(timeout time.Duration) (*FlowResult, error) {
	b.mu.Lock()
	if b.flowResultCh == nil {
		b.flowResultCh = make(chan FlowResult, 1)
	}
	ch := b.flowResultCh
	b.mu.Unlock()

	select {
	case result := <-ch:
		if result.Error != "" {
			return nil, fmt.Errorf("%s", result.Error)
		}
		return &result, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("timeout: không nhận được kết quả sau %v", timeout)
	}
}

// WaitForFlowResultWithContext chờ kết quả + hỗ trợ cancel qua context
func (b *Bridge) WaitForFlowResultWithContext(ctx context.Context, timeout time.Duration) (*FlowResult, error) {
	b.mu.Lock()
	if b.flowResultCh == nil {
		b.flowResultCh = make(chan FlowResult, 1)
	}
	ch := b.flowResultCh
	b.mu.Unlock()

	select {
	case result := <-ch:
		if result.Error != "" {
			return nil, fmt.Errorf("%s", result.Error)
		}
		return &result, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("timeout: không nhận được kết quả sau %v", timeout)
	case <-ctx.Done():
		return nil, fmt.Errorf("đã dừng bởi người dùng")
	}
}

// Start khởi động WebSocket server
func (b *Bridge) Start() error {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return nil
	}
	b.stopCh = make(chan struct{})
	b.running = true
	b.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/", b.handleWS)

	b.server = &http.Server{
		Addr:    fmt.Sprintf(":%d", b.port),
		Handler: mux,
	}

	log.Printf("Bridge: Đang khởi động WebSocket server trên port %d...", b.port)
	b.notifyStatus(true, false)

	go func() {
		err := b.server.ListenAndServe()
		if err != nil && err != http.ErrServerClosed {
			log.Printf("Bridge: Lỗi server: %v", err)
		}
		log.Println("Bridge: Server đã dừng")
	}()

	return nil
}

// Stop dừng WebSocket server
func (b *Bridge) Stop() {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.running {
		return
	}

	b.running = false
	if b.stopCh != nil {
		close(b.stopCh)
	}

	if b.conn != nil {
		b.conn.Close()
		b.conn = nil
	}

	if b.server != nil {
		b.server.Close()
		b.server = nil
	}

	log.Println("Bridge: Đã tắt")
	b.notifyStatusLocked(false, false)
}

// IsRunning kiểm tra bridge có đang chạy
func (b *Bridge) IsRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

// IsExtensionConnected kiểm tra extension có kết nối
func (b *Bridge) IsExtensionConnected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn != nil
}

// SendPrompt gửi prompt tới extension
func (b *Bridge) SendPrompt(id string, content string) error {
	b.mu.Lock()
	conn := b.conn
	b.mu.Unlock()

	if conn == nil {
		return fmt.Errorf("extension chưa kết nối")
	}

	msg := map[string]interface{}{
		"type":    "prompt",
		"id":      id,
		"content": content,
	}
	return conn.WriteJSON(msg)
}

// handleWS xử lý kết nối WebSocket từ extension
func (b *Bridge) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Bridge: Lỗi upgrade WebSocket: %v", err)
		return
	}

	log.Println("Bridge: ✅ Extension đã kết nối!")

	b.mu.Lock()
	// Đóng kết nối cũ nếu có
	if b.conn != nil {
		b.conn.Close()
	}
	b.conn = conn
	b.mu.Unlock()

	b.notifyStatus(true, true)

	// Ping/pong keepalive
	conn.SetPongHandler(func(appData string) error {
		return nil
	})

	// Read messages loop
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Bridge: Extension ngắt kết nối: %v", err)
			break
		}
		b.handleMessage(msg)
	}

	// Cleanup
	b.mu.Lock()
	if b.conn == conn {
		b.conn = nil
	}
	b.mu.Unlock()

	b.notifyStatus(true, false)
}

// handleMessage xử lý message từ extension
func (b *Bridge) handleMessage(raw []byte) {
	// Parse JSON
	var msg map[string]interface{}
	if err := parseJSON(raw, &msg); err != nil {
		log.Printf("Bridge: Lỗi parse message: %v", err)
		return
	}

	msgType, _ := msg["type"].(string)

	switch msgType {
	case "ping":
		// Respond with pong
		b.mu.Lock()
		conn := b.conn
		b.mu.Unlock()
		if conn != nil {
			conn.WriteJSON(map[string]string{"type": "pong"})
		}

	case "response":
		id, _ := msg["id"].(string)
		content, _ := msg["content"].(string)
		status, _ := msg["status"].(string)
		log.Printf("Bridge: Nhận response [%s]: %s...", id, truncate(content, 80))

		b.mu.Lock()
		fn := b.onResponse
		b.mu.Unlock()
		if fn != nil {
			fn(id, content, status)
		}

	case "error":
		id, _ := msg["id"].(string)
		errMsg, _ := msg["error"].(string)
		log.Printf("Bridge: Lỗi từ extension [%s]: %s", id, errMsg)

		b.mu.Lock()
		fn := b.onResponse
		b.mu.Unlock()
		if fn != nil {
			fn(id, "", "error: "+errMsg)
		}

	case "flow_result":
		id, _ := msg["id"].(string)
		prompt, _ := msg["prompt"].(string)
		var images []FlowImage
		if rawImages, ok := msg["images"].([]interface{}); ok {
			for _, ri := range rawImages {
				if imgMap, ok := ri.(map[string]interface{}); ok {
					img := FlowImage{
						URL:    fmt.Sprintf("%v", imgMap["url"]),
						Base64: fmt.Sprintf("%v", imgMap["base64"]),
					}
					if idx, ok := imgMap["index"].(float64); ok {
						img.Index = int(idx)
					}
					images = append(images, img)
				}
			}
		}
		log.Printf("Bridge: ✅ Flow result [%s]: %d ảnh", id, len(images))

		b.mu.Lock()
		ch := b.flowResultCh
		b.mu.Unlock()
		if ch != nil {
			ch <- FlowResult{ID: id, Prompt: prompt, Images: images}
		}

	case "flow_progress":
		id, _ := msg["id"].(string)
		status, _ := msg["status"].(string)
		message, _ := msg["message"].(string)
		log.Printf("Bridge: Flow progress [%s]: %s - %s", id, status, message)

		b.mu.Lock()
		fn := b.onFlowProgress
		b.mu.Unlock()
		if fn != nil {
			fn(id, status, message)
		}

	case "flow_error":
		id, _ := msg["id"].(string)
		errMsg, _ := msg["error"].(string)
		log.Printf("Bridge: ❌ Flow error [%s]: %s", id, errMsg)

		b.mu.Lock()
		ch := b.flowResultCh
		b.mu.Unlock()
		if ch != nil {
			ch <- FlowResult{ID: id, Error: errMsg}
		}

	default:
		log.Printf("Bridge: Message không xác định: %s", msgType)
	}
}

func (b *Bridge) notifyStatus(running, connected bool) {
	b.mu.Lock()
	fn := b.onStatusChange
	b.mu.Unlock()
	if fn != nil {
		fn(running, connected)
	}
}

func (b *Bridge) notifyStatusLocked(running, connected bool) {
	fn := b.onStatusChange
	if fn != nil {
		go fn(running, connected)
	}
}

// ─── Helpers ─────────────────────────────────────────────────

func parseJSON(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// StartHeartbeat bắt đầu gửi ping định kỳ
func (b *Bridge) StartHeartbeat() {
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-b.stopCh:
				return
			case <-ticker.C:
				b.mu.Lock()
				conn := b.conn
				b.mu.Unlock()
				if conn != nil {
					conn.WriteMessage(websocket.PingMessage, nil)
				}
			}
		}
	}()
}
