package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SupabaseRequest là request HTTP mà supabase-js (frontend) nhờ backend gửi hộ.
// Dùng khi cấu hình Secret key: Supabase từ chối secret key nếu request đến từ trình duyệt
// (WebView của app cũng tính là trình duyệt), nên phải gửi từ Go.
type SupabaseRequest struct {
	BaseURL string            `json:"baseUrl"` // Project URL đã cấu hình — request chỉ được đi tới đây
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// SupabaseResponse là phản hồi trả lại cho supabase-js
type SupabaseResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Error   string            `json:"error"`
}

var supabaseHTTPClient = &http.Client{Timeout: 60 * time.Second}

// SupabaseFetch gửi request tới Supabase từ backend
func (a *App) SupabaseFetch(req SupabaseRequest) SupabaseResponse {
	base := strings.TrimRight(req.BaseURL, "/")
	if base == "" || !strings.HasPrefix(req.URL, base+"/") {
		// Không cho gửi secret key tới host khác ngoài Project URL
		return SupabaseResponse{Error: fmt.Sprintf("URL không thuộc Supabase project: %s", req.URL)}
	}

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequest(req.Method, req.URL, body)
	if err != nil {
		return SupabaseResponse{Error: err.Error()}
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := supabaseHTTPClient.Do(httpReq)
	if err != nil {
		return SupabaseResponse{Error: err.Error()}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return SupabaseResponse{Error: err.Error()}
	}

	headers := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}
	return SupabaseResponse{Status: resp.StatusCode, Headers: headers, Body: string(data)}
}
