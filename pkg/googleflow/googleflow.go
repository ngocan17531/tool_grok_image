package googleflow

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// GoogleFlowConfig chứa cấu hình cho Google Flow generation
type GoogleFlowConfig struct {
	Output   string
	AlbumID  string
	Prompts  []string
	Download bool
	FlowURL  string // URL dự án Google Flow
}

// GoogleFlowImage đại diện cho ảnh được tạo
type GoogleFlowImage struct {
	URL    string
	Prompt string
	File   string
}

// StatusCallback để report tiến độ về frontend
type StatusCallback func(current, total int, msg string, isError bool)

// GoogleFlowChrome quản lý singleton Chrome instance cho Google Flow
type GoogleFlowChrome struct {
	mu          sync.Mutex
	allocCtx    context.Context
	allocCancel context.CancelFunc
	ctx         context.Context
	cancel      context.CancelFunc
	running     bool
}

var instance = &GoogleFlowChrome{}

// GetInstance trả về singleton GoogleFlowChrome
func GetInstance() *GoogleFlowChrome {
	return instance
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// Start khởi động Chrome và mở Google Flow
func (g *GoogleFlowChrome) Start(parentCtx context.Context, flowURL string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.running {
		return nil
	}

	profileDir := "googleflow_profile"
	if err := os.MkdirAll(profileDir, 0755); err != nil {
		log.Printf("GoogleFlow: Không thể tạo thư mục profile: %v", err)
	}
	absProfile, _ := filepath.Abs(profileDir)

	opts := []chromedp.ExecAllocatorOption{
		// Cơ bản: KHÔNG headless, hiển thị Chrome
		chromedp.Flag("headless", false),
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		
		// Ẩn dấu automation — QUAN TRỌNG cho Google
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		// KHÔNG dùng --enable-automation (Google sẽ phát hiện và block)
		
		// Profile & Window
		chromedp.UserDataDir(absProfile),
		chromedp.WindowSize(1280, 900),
		
		// Stability flags (an toàn, không gây lỗi Google)
		chromedp.Flag("disable-popup-blocking", true),
		chromedp.Flag("disable-prompt-on-repost", true),
		chromedp.Flag("disable-hang-monitor", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("no-default-browser-check", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-background-timer-throttling", true),
		chromedp.Flag("disable-backgrounding-occluded-windows", true),
		chromedp.Flag("disable-renderer-backgrounding", true),
	}

	allocCtx, allocCancel := chromedp.NewExecAllocator(parentCtx, opts...)
	ctx, cancel := chromedp.NewContext(allocCtx)

	// Ẩn dấu automation
	if err := chromedp.Run(ctx, chromedp.ActionFunc(func(cxt context.Context) error {
		_, err := page.AddScriptToEvaluateOnNewDocument(
			`Object.defineProperty(navigator, 'webdriver', { get: () => false });
			 window.chrome = { runtime: {} };`,
		).Do(cxt)
		return err
	})); err != nil {
		cancel()
		allocCancel()
		return fmt.Errorf("không thể khởi tạo Chrome: %w", err)
	}

	g.allocCtx = allocCtx
	g.allocCancel = allocCancel
	g.ctx = ctx
	g.cancel = cancel
	g.running = true

	go func() {
		targetURL := flowURL
		if targetURL == "" {
			targetURL = "https://labs.google"
		}
		log.Printf("GoogleFlow: Đang mở %s...", targetURL)
		if err := chromedp.Run(ctx, chromedp.Navigate(targetURL)); err != nil {
			if !strings.Contains(err.Error(), "context canceled") {
				log.Printf("GoogleFlow: Lỗi navigate: %v", err)
			}
			return
		}
		log.Println("GoogleFlow: Đã mở trang. Hãy đăng nhập Google nếu cần.")
	}()

	return nil
}

// Stop đóng Chrome
func (g *GoogleFlowChrome) Stop() {
	g.mu.Lock()
	defer g.mu.Unlock()

	if !g.running {
		return
	}
	if g.cancel != nil {
		g.cancel()
		g.cancel = nil
	}
	if g.allocCancel != nil {
		g.allocCancel()
		g.allocCancel = nil
	}
	g.running = false
	g.ctx = nil
	log.Println("GoogleFlow: Đã tắt Chrome.")
}

// IsRunning kiểm tra Chrome có đang chạy không
func (g *GoogleFlowChrome) IsRunning() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.running
}

func (g *GoogleFlowChrome) getCtx() context.Context {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Generation
// ─────────────────────────────────────────────────────────────────────────────

// GenerateBatch chạy tất cả prompt tuần tự
func (g *GoogleFlowChrome) GenerateBatch(cfg *GoogleFlowConfig, onProgress StatusCallback) ([]*GoogleFlowImage, error) {
	ctx := g.getCtx()
	if ctx == nil {
		return nil, fmt.Errorf("Chrome chưa được khởi động")
	}

	// Tạo thư mục output
	albumDir := filepath.Join(cfg.Output, cfg.AlbumID)
	imgDir := filepath.Join(albumDir, "images")
	thumbDir := filepath.Join(imgDir, "_thumbnails")
	if cfg.Download {
		_ = os.MkdirAll(imgDir, 0755)
		_ = os.MkdirAll(thumbDir, 0755)
	}

	total := len(cfg.Prompts)
	if onProgress != nil {
		onProgress(0, total, "Đang điều hướng đến trang Google Flow...", false)
	}

	// Navigate đến trang Flow
	if err := g.navigateToFlowPage(ctx, cfg.FlowURL); err != nil {
		return nil, err
	}
	if err := g.waitForReady(ctx); err != nil {
		return nil, err
	}

	var allImages []*GoogleFlowImage
	processedURLs := make(map[string]bool)

	for i, prompt := range cfg.Prompts {
		select {
		case <-ctx.Done():
			return allImages, fmt.Errorf("đã dừng")
		default:
		}

		if onProgress != nil {
			onProgress(i, total, fmt.Sprintf("[%d/%d] ⌨️ Nhập prompt: %s", i+1, total, truncate(prompt, 60)), false)
		}

		imgs, err := g.generateOne(ctx, prompt, i, imgDir, thumbDir, cfg.Download, processedURLs, onProgress, i, total)
		if err != nil {
			log.Printf("GoogleFlow: Lỗi prompt %d: %v", i, err)
			if onProgress != nil {
				onProgress(i+1, total, fmt.Sprintf("[%d/%d] ❌ Lỗi: %v", i+1, total, err), true)
			}
		} else {
			allImages = append(allImages, imgs...)
			for _, img := range imgs {
				processedURLs[img.URL] = true
			}
			if onProgress != nil {
				onProgress(i+1, total, fmt.Sprintf("[%d/%d] ✅ Xong — %d ảnh", i+1, total, len(imgs)), false)
			}
		}

		// Chờ giữa các prompt
		if i < total-1 {
			time.Sleep(3 * time.Second)
		}
	}

	return allImages, nil
}

// navigateToFlowPage điều hướng đến trang Google Flow project
// Nếu đã ở đúng trang → KHÔNG reload lại
func (g *GoogleFlowChrome) navigateToFlowPage(ctx context.Context, flowURL string) error {
	if flowURL == "" {
		flowURL = "https://labs.google"
	}

	// Kiểm tra xem đang ở đúng trang chưa
	var currentURL string
	_ = chromedp.Run(ctx, chromedp.Evaluate(`window.location.href`, &currentURL))
	
	// So sánh URL hiện tại với target (bỏ qua trailing slash và query params)
	currentBase := strings.Split(strings.TrimRight(currentURL, "/"), "?")[0]
	targetBase := strings.Split(strings.TrimRight(flowURL, "/"), "?")[0]
	
	if currentBase == targetBase {
		log.Printf("GoogleFlow: Đã ở đúng trang %s — không cần reload", truncate(currentURL, 60))
		return nil
	}

	log.Printf("GoogleFlow: Đang mở %s... (hiện tại: %s)", flowURL, truncate(currentURL, 60))
	err := chromedp.Run(ctx, chromedp.Navigate(flowURL))
	if err != nil {
		return fmt.Errorf("không thể navigate %s: %w", flowURL, err)
	}
	time.Sleep(3 * time.Second)
	return nil
}

// waitForReady chờ trang load xong VÀ UI render đầy đủ (tối đa 3 phút)
// Kiểm tra: input tồn tại + có buttons trên trang (trang không bị đen)
func (g *GoogleFlowChrome) waitForReady(ctx context.Context) error {
	log.Println("GoogleFlow: Đang chờ trang sẵn sàng...")
	deadline := time.Now().Add(3 * time.Minute)
	reloadedOnce := false
	startTime := time.Now()

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("đã hủy")
		case <-time.After(2 * time.Second):
		}

		// Kiểm tra input + buttons (UI render đầy đủ)
		var readyInfo string
		_ = chromedp.Run(ctx, chromedp.Evaluate(`
			(function() {
				// Tìm input
				let inputOK = false;
				const ce = document.querySelector('[contenteditable="true"]');
				if (ce && ce.offsetParent !== null) inputOK = true;
				const ta = document.querySelector('textarea');
				if (ta && ta.offsetParent !== null) inputOK = true;
				const inp = document.querySelector('input[type="text"]:not([type="hidden"])');
				if (inp && inp.offsetParent !== null) inputOK = true;
				const tb = document.querySelector('[role="textbox"]');
				if (tb && tb.offsetParent !== null) inputOK = true;

				// Đếm buttons visible (UI render check)
				const allBtns = document.querySelectorAll('button');
				let visibleBtns = 0;
				for (const btn of allBtns) {
					if (btn.offsetParent !== null) visibleBtns++;
				}

				if (inputOK && visibleBtns >= 5) {
					return 'ready:' + visibleBtns;
				}
				return 'not_ready:input=' + inputOK + ',buttons=' + visibleBtns;
			})()
		`, &readyInfo))

		if strings.HasPrefix(readyInfo, "ready:") {
			log.Printf("GoogleFlow: Trang sẵn sàng! Input OK + %s buttons", strings.TrimPrefix(readyInfo, "ready:"))
			return nil
		}

		log.Printf("GoogleFlow: Chờ UI render... (%s)", readyInfo)

		// Nếu đã chờ > 30s mà trang vẫn không render → reload
		if !reloadedOnce && time.Since(startTime) > 30*time.Second {
			log.Println("GoogleFlow: ⚠️ Trang không render sau 30s — reload trang...")
			_ = chromedp.Run(ctx, chromedp.Reload())
			time.Sleep(3 * time.Second)
			reloadedOnce = true
		}

		// Kiểm tra có đang ở trang login không
		var currentURL string
		_ = chromedp.Run(ctx, chromedp.Evaluate(`window.location.href`, &currentURL))
		if strings.Contains(currentURL, "accounts.google.com") {
			log.Println("GoogleFlow: Đang ở trang đăng nhập Google — vui lòng đăng nhập thủ công...")
		}
	}

	return fmt.Errorf("timeout: trang không render sau 3 phút. Có thể cần đăng nhập Google trước")
}

// ─────────────────────────────────────────────────────────────────────────────
// Single Prompt Generation
// ─────────────────────────────────────────────────────────────────────────────

// generateOne xử lý 1 prompt: nhập → submit → chờ ảnh → download
func (g *GoogleFlowChrome) generateOne(
	ctx context.Context,
	prompt string,
	promptIdx int,
	imgDir, thumbDir string,
	doDownload bool,
	processedURLs map[string]bool,
	onProgress StatusCallback,
	current, total int,
) ([]*GoogleFlowImage, error) {

	// ── 1. Tìm và nhập prompt ──────────────────────────────────────────
	if onProgress != nil {
		onProgress(current, total, fmt.Sprintf("[%d/%d] ⌨️ Đang nhập prompt...", current+1, total), false)
	}

	if err := g.typePromptAndSubmit(ctx, prompt); err != nil {
		return nil, err
	}

	// ── 2. Chờ ảnh render ──────────────────────────────────────────────
	if onProgress != nil {
		onProgress(current, total, fmt.Sprintf("[%d/%d] ⏳ Đang chờ Google Flow tạo ảnh...", current+1, total), false)
	}

	imageURLs := g.waitForNewImages(ctx, processedURLs)
	if len(imageURLs) == 0 {
		// Trang có thể bị freeze → reload và báo lỗi
		log.Println("GoogleFlow: Không tìm thấy ảnh, thử reload trang...")
		_ = chromedp.Run(ctx, chromedp.Reload())
		time.Sleep(3 * time.Second)
		return nil, fmt.Errorf("không tìm thấy ảnh mới nào sau khi chờ")
	}
	log.Printf("GoogleFlow: ✅ Tìm thấy %d ảnh MỚI cho prompt #%d", len(imageURLs), promptIdx)

	// ── 3. Download ảnh ────────────────────────────────────────────────
	var images []*GoogleFlowImage
	for i, u := range imageURLs {
		ext := ".png"
		if strings.Contains(u, ".jpg") || strings.Contains(u, ".jpeg") {
			ext = ".jpg"
		} else if strings.Contains(u, ".webp") {
			ext = ".webp"
		}
		cleanName := cleanFileName(prompt)
		fileName := fmt.Sprintf("gflow_%s_%05d_%02d%s", cleanName, promptIdx, i, ext)
		img := &GoogleFlowImage{URL: u, Prompt: prompt, File: fileName}

		if doDownload {
			if onProgress != nil {
				onProgress(current, total, fmt.Sprintf("[%d/%d] 📥 Download ảnh %d/%d...", current+1, total, i+1, len(imageURLs)), false)
			}
			outPath := filepath.Join(imgDir, fileName)
			if err := g.downloadViaJS(ctx, u, outPath); err != nil {
				log.Printf("GoogleFlow: JS download thất bại (%v), thử HTTP...", err)
				if _, err2 := downloadImageHTTP(u, imgDir, thumbDir, fileName); err2 != nil {
					log.Printf("GoogleFlow: ❌ Không download được ảnh %d: %v", i, err2)
					continue
				}
			} else {
				log.Printf("GoogleFlow: 💾 Đã lưu: %s", fileName)
				if data, rdErr := os.ReadFile(outPath); rdErr == nil {
					thumbName := strings.TrimSuffix(fileName, filepath.Ext(fileName)) + ".jpg"
					_ = os.WriteFile(filepath.Join(thumbDir, thumbName), data, 0644)
				}
			}
			img.File = fileName
		}
		images = append(images, img)
	}

	return images, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Input & Submit
// ─────────────────────────────────────────────────────────────────────────────

// typePromptAndSubmit tìm input → xóa → nhập prompt → submit
// Google Flow dùng framework Angular/Lit — cần dùng real keyboard events (SendKeys) làm chính
func (g *GoogleFlowChrome) typePromptAndSubmit(ctx context.Context, prompt string) error {
	log.Printf("GoogleFlow: Chuẩn bị submit: %s", truncate(prompt, 80))

	// ── Bước A: Tìm input ────────────────────────────────────────────────
	var inputInfo string
	err := chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// 1. Textarea (Google Flow thường dùng textarea)
			const ta = document.querySelector('textarea');
			if (ta && ta.offsetParent !== null) return 'textarea:textarea';

			// 2. contenteditable
			const ce = document.querySelector('[contenteditable="true"]');
			if (ce && ce.offsetParent !== null) return 'contenteditable:[contenteditable="true"]';

			// 3. ProseMirror
			const pm = document.querySelector('div.ProseMirror[contenteditable="true"]');
			if (pm && pm.offsetParent !== null) return 'prosemirror:div.ProseMirror[contenteditable="true"]';

			// 4. Role textbox
			const tb = document.querySelector('[role="textbox"]');
			if (tb && tb.offsetParent !== null) return 'textbox:[role="textbox"]';

			// 5. Input text
			const inp = document.querySelector('input[type="text"]:not([type="hidden"])');
			if (inp && inp.offsetParent !== null) return 'input:input[type="text"]';

			return '';
		})()
	`, &inputInfo))

	if err != nil || inputInfo == "" {
		var currentURL string
		_ = chromedp.Run(ctx, chromedp.Evaluate(`window.location.href`, &currentURL))
		log.Printf("GoogleFlow: Không tìm thấy input! URL = %s", currentURL)
		return fmt.Errorf("không tìm thấy ô nhập prompt (URL: %s)", currentURL)
	}

	log.Printf("GoogleFlow: Tìm thấy input: %s", inputInfo)

	parts := strings.SplitN(inputInfo, ":", 2)
	if len(parts) < 2 {
		return fmt.Errorf("input info không hợp lệ: %s", inputInfo)
	}
	sel := parts[1]

	// ── Bước B: Click vào input để focus ──────────────────────────────────
	if err := chromedp.Run(ctx, chromedp.Click(sel, chromedp.ByQuery)); err != nil {
		log.Printf("GoogleFlow: Không click được, thử JS focus: %v", err)
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(
			`document.querySelector('%s')?.focus()`, escapeSelector(sel),
		), nil))
	}
	time.Sleep(500 * time.Millisecond)

	// ── Bước C: Nhập prompt ──────────────────────────────────────────────
	// Google Flow: contenteditable chứa placeholder "Bạn muốn tạo gì?" BÊN TRONG
	// PHẢI LUÔN selectAll + delete trước khi insertText

	inserted := false

	// === Strategy 1 (CHÍNH): Click → selectAll+delete → sleep → insertText ===
	log.Println("GoogleFlow: [Strategy 1] click → selectAll+delete → insertText")
	
	// Click vào contenteditable để focus
	if err := chromedp.Run(ctx, chromedp.Click(sel, chromedp.ByQuery)); err != nil {
		log.Printf("GoogleFlow: Click thất bại: %v", err)
	}
	time.Sleep(500 * time.Millisecond)

	// Bước 1: Xóa tất cả nội dung (bao gồm placeholder)
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return;
			el.focus();
			document.execCommand('selectAll', false, null);
			document.execCommand('delete', false, null);
		})()
	`, escapeSelector(sel)), nil))
	
	// Chờ framework xử lý xong việc xóa
	time.Sleep(500 * time.Millisecond)

	// Bước 2: Nhập prompt mới (SAU KHI framework đã xóa xong)
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return;
			el.focus();
			document.execCommand('insertText', false, %q);
		})()
	`, escapeSelector(sel), prompt), nil))
	
	time.Sleep(1000 * time.Millisecond)
	inserted = g.verifyInputContent(ctx, sel, prompt)

	// === Strategy 2: SendKeys (real keyboard events) ===
	if !inserted {
		log.Println("GoogleFlow: [Strategy 2] focus → selectAll+delete → SendKeys")
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
			(function() {
				const el = document.querySelector('%s');
				if (!el) return;
				el.focus();
				document.execCommand('selectAll', false, null);
				document.execCommand('delete', false, null);
				el.focus();
			})()
		`, escapeSelector(sel)), nil))
		time.Sleep(400 * time.Millisecond)

		if err := chromedp.Run(ctx, chromedp.SendKeys(sel, prompt, chromedp.ByQuery)); err != nil {
			log.Printf("GoogleFlow: SendKeys thất bại: %v", err)
		} else {
			time.Sleep(800 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, prompt)
		}
	}

	// === Strategy 3: nativeInputValueSetter (cho textarea/input) ===
	if !inserted {
		log.Println("GoogleFlow: [Strategy 3] nativeInputValueSetter + InputEvent")
		var setOk bool
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
			(function() {
				const el = document.querySelector('%s');
				if (!el) return false;
				el.focus();
				let setter;
				if (el.tagName === 'TEXTAREA') {
					setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
				} else if (el.tagName === 'INPUT') {
					setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
				}
				if (setter) {
					setter.call(el, '');
					el.dispatchEvent(new Event('input', { bubbles: true }));
					setter.call(el, %q);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
					return true;
				}
				return false;
			})()
		`, escapeSelector(sel), prompt), &setOk))
		if setOk {
			time.Sleep(500 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, prompt)
		}
	}

	// Log kết quả cuối cùng
	var finalContent string
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return '';
			return (el.value || el.innerText || el.textContent || '').trim();
		})()
	`, escapeSelector(sel)), &finalContent))
	log.Printf("GoogleFlow: Nội dung cuối cùng trong input (%d chars): %s", len(finalContent), truncate(finalContent, 80))

	if !inserted {
		log.Println("GoogleFlow: ⚠️ Không chắc prompt đã được nhập đúng, nhưng vẫn thử submit...")
	}

	// ── Bước D: Chờ 3 giây để framework xử lý xong trước khi submit ────
	log.Println("GoogleFlow: ⏳ Đợi 3 giây để framework xử lý prompt...")
	time.Sleep(3 * time.Second)

	// ── Bước E: Submit ────────────────────────────────────────────────────
	return g.submitForm(ctx, sel)
}

// verifyInputContent kiểm tra nội dung đã được nhập đúng
// Lưu ý: contenteditable elements có thể trả về placeholder text
func (g *GoogleFlowChrome) verifyInputContent(ctx context.Context, sel, expected string) bool {
	var content string
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return '';
			
			// Lấy nội dung thực (không phải placeholder)
			let v = '';
			if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
				v = el.value || '';
			} else {
				// Contenteditable: kiểm tra innerText
				v = el.innerText || el.textContent || '';
			}
			v = v.trim();
			
			// Lọc bỏ placeholder text phổ biến
			const placeholders = ['Bạn muốn tạo gì?', 'What do you want to create?', 
				'Enter a prompt', 'Type a message', 'Nhập câu lệnh'];
			for (const ph of placeholders) {
				if (v === ph) return '';
			}
			
			return v;
		})()
	`, escapeSelector(sel)), &content))

	if len(content) < 3 {
		log.Printf("GoogleFlow: ❌ Verify FAILED — input rỗng hoặc quá ngắn: '%s'", truncate(content, 30))
		return false
	}

	// Kiểm tra placeholder CÒN NẰM TRONG content → insertion sai
	placeholders := []string{"Bạn muốn tạo gì?", "What do you want to create?"}
	for _, ph := range placeholders {
		if strings.Contains(content, ph) {
			log.Printf("GoogleFlow: ❌ Verify FAILED — placeholder '%s' vẫn còn trong content", ph)
			return false
		}
	}

	expectedCore := expected
	if len(expectedCore) > 20 {
		expectedCore = expectedCore[:20]
	}

	if strings.Contains(content, expectedCore) {
		log.Printf("GoogleFlow: ✅ Verify OK — prompt đã được nhập (%d chars)", len(content))
		return true
	}

	log.Printf("GoogleFlow: ❌ Verify FAILED — nội dung không khớp. Got: '%s'", truncate(content, 50))
	return false
}

// submitForm: nhấn nút Submit/Send hoặc Enter
// Google Flow: nút → (arrow) nằm ở BÊN PHẢI NHẤT trong thanh input bar
func (g *GoogleFlowChrome) submitForm(ctx context.Context, inputSel string) error {
	// Đầu tiên: log tất cả buttons trên trang để debug
	var debugInfo string
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const input = document.querySelector('%s');
			const inputRect = input ? input.getBoundingClientRect() : null;
			const allBtns = Array.from(document.querySelectorAll('button'));
			let info = 'Total buttons: ' + allBtns.length + '\\n';
			for (let i = 0; i < allBtns.length; i++) {
				const btn = allBtns[i];
				const rect = btn.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) continue;
				const label = btn.getAttribute('aria-label') || '';
				const hasSvg = !!btn.querySelector('svg');
				const hasIcon = !!btn.querySelector('mat-icon, i, span.material-icons');
				const disabled = btn.disabled;
				const text = (btn.textContent || '').trim().substring(0, 20);
				info += 'btn[' + i + ']: ' + Math.round(rect.left) + ',' + Math.round(rect.top) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' svg=' + hasSvg + ' icon=' + hasIcon + ' disabled=' + disabled + ' label="' + label + '" text="' + text + '"\\n';
			}
			return info;
		})()
	`, escapeSelector(inputSel)), &debugInfo))
	log.Printf("GoogleFlow: [Submit Debug] %s", debugInfo)

	// Tìm và click nút submit
	var clicked bool
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const input = document.querySelector('%s');
			
			// === 1. Tìm nút ARROW (→) ở bên phải nhất trong parent containers ===
			if (input) {
				let parent = input.parentElement;
				for (let depth = 0; depth < 10 && parent; depth++) {
					const btns = Array.from(parent.querySelectorAll('button'));
					if (btns.length === 0) {
						parent = parent.parentElement;
						continue;
					}
					
					// Tìm tất cả nút visible (có SVG, icon, hoặc bất kỳ)
					let candidateBtns = [];
					for (const btn of btns) {
						if (btn.disabled || btn.offsetParent === null) continue;
						const rect = btn.getBoundingClientRect();
						if (rect.width <= 0 || rect.height <= 0) continue;
						if (rect.width > 200) continue; // Bỏ qua nút quá to (navigation)
						
						candidateBtns.push({ btn, x: rect.right, y: rect.top, w: rect.width, h: rect.height });
					}
					
					if (candidateBtns.length >= 1) {
						// Chọn nút bên PHẢI NHẤT (x lớn nhất) — đó là nút →
						candidateBtns.sort((a, b) => b.x - a.x);
						// Nút phải nhất thường là submit
						candidateBtns[0].btn.click();
						return true;
					}
					parent = parent.parentElement;
				}
			}

			// === 2. Tìm theo aria-label patterns ===
			const candidates = [
				document.querySelector('button[aria-label="Send"]'),
				document.querySelector('button[aria-label="Submit"]'),
				document.querySelector('button[aria-label*="send"]'),
				document.querySelector('button[aria-label*="submit"]'),
				document.querySelector('button[aria-label*="Run"]'),
				document.querySelector('button[aria-label*="run"]'),
				document.querySelector('button[aria-label*="Generate"]'),
				document.querySelector('button[aria-label*="Gửi"]'),
				document.querySelector('button[aria-label*="gửi"]'),
				document.querySelector('button[type="submit"]'),
			];

			for (const btn of candidates) {
				if (btn && !btn.disabled && btn.offsetParent !== null) {
					btn.click();
					return true;
				}
			}

			// === 3. Fallback: nút bên phải nhất cuối trang ===
			const allBtns = Array.from(document.querySelectorAll('button'));
			let rightmost = null;
			let maxX = -1;
			for (const btn of allBtns) {
				if (btn.disabled || btn.offsetParent === null) continue;
				const rect = btn.getBoundingClientRect();
				if (rect.width <= 0 || rect.width > 100) continue;
				// Nút ở nửa dưới trang, bên phải nhất
				if (rect.bottom > 400 && rect.right > maxX) {
					maxX = rect.right;
					rightmost = btn;
				}
			}
			if (rightmost) {
				rightmost.click();
				return true;
			}

			return false;
		})()
	`, escapeSelector(inputSel)), &clicked))

	if clicked {
		log.Println("GoogleFlow: ✅ Đã click nút Submit")
		return nil
	}

	// Fallback: nhấn Enter trên input
	log.Println("GoogleFlow: Không tìm thấy nút Submit, nhấn Enter...")
	
	// Focus lại input trước khi nhấn Enter
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(
		`document.querySelector('%s')?.focus()`, escapeSelector(inputSel),
	), nil))
	time.Sleep(200 * time.Millisecond)
	
	if err := chromedp.Run(ctx, chromedp.KeyEvent("\r")); err != nil {
		_ = chromedp.Run(ctx, chromedp.Evaluate(`
			document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Enter', code: 'Enter', keyCode: 13,
				which: 13, bubbles: true, cancelable: true
			}))
		`, nil))
	}

	log.Println("GoogleFlow: ✅ Đã nhấn Enter")
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Collection
// ─────────────────────────────────────────────────────────────────────────────

// waitForNewImages chờ ảnh MỚI render trong DOM
func (g *GoogleFlowChrome) waitForNewImages(ctx context.Context, processedURLs map[string]bool) []string {
	log.Printf("GoogleFlow: Đang chờ ảnh MỚI render trong DOM (đã có %d ảnh cũ)...", len(processedURLs))
	deadline := time.Now().Add(3 * time.Minute)
	var lastNewURLs []string
	stableCount := 0
	firstImageTime := time.Time{}

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return lastNewURLs
		case <-time.After(3 * time.Second):
		}

		allURLs := g.getGeneratedImages(ctx)

		// Lọc chỉ lấy ảnh MỚI
		var newURLs []string
		for _, u := range allURLs {
			if !processedURLs[u] {
				newURLs = append(newURLs, u)
			}
		}

		if len(newURLs) > 0 && firstImageTime.IsZero() {
			firstImageTime = time.Now()
			log.Printf("GoogleFlow: 📸 Phát hiện %d ảnh MỚI đầu tiên", len(newURLs))
		}

		if len(newURLs) > 0 {
			if len(newURLs) == len(lastNewURLs) && sameSlice(newURLs, lastNewURLs) {
				stableCount++

				// Ổn định 3 lần (9s) → lấy luôn
				if stableCount >= 3 {
					log.Printf("GoogleFlow: ✅ Ảnh ổn định! Tìm thấy %d ảnh MỚI", len(newURLs))
					return newURLs
				}

				log.Printf("GoogleFlow: DOM scan: %d ảnh MỚI (đợi ổn định %d/3...)", len(newURLs), stableCount)
			} else {
				stableCount = 0
				log.Printf("GoogleFlow: DOM scan: %d ảnh MỚI (đang load thêm...)", len(newURLs))
			}
			lastNewURLs = newURLs
		}

		// Timeout 60s sau ảnh đầu tiên
		if !firstImageTime.IsZero() && time.Since(firstImageTime) > 60*time.Second && len(lastNewURLs) > 0 {
			log.Printf("GoogleFlow: ⚠️ Timeout 60s sau ảnh đầu tiên, lấy %d ảnh", len(lastNewURLs))
			return lastNewURLs
		}
	}

	if len(lastNewURLs) > 0 {
		log.Printf("GoogleFlow: ⏰ Timeout nhưng có %d ảnh MỚI, sử dụng luôn", len(lastNewURLs))
	}
	return lastNewURLs
}

// getGeneratedImages lấy URLs ảnh đã tạo trong DOM
// Google Flow ảnh generated thường nằm trong img tags với src chứa các domain Google
func (g *GoogleFlowChrome) getGeneratedImages(ctx context.Context) []string {
	var urls []string
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			const result = [];
			const seen = new Set();
			const imgs = document.querySelectorAll('img[src]');
			for (const img of imgs) {
				const src = img.src || '';
				// Bỏ qua ảnh nhỏ (icon, avatar, logo)
				if (!img.complete || img.naturalWidth < 150 || img.naturalHeight < 150) continue;
				
				// Bỏ qua các asset UI
				const lower = src.toLowerCase();
				if (lower.includes('favicon') || lower.includes('logo') || lower.includes('icon') ||
					lower.includes('avatar') || lower.includes('.svg') || lower.includes('emoji') ||
					lower.includes('sprite') || lower.includes('profile') || lower.includes('data:image/svg')) continue;

				// Chấp nhận ảnh từ Google domains hoặc blob URLs
				const isGoogleImg = lower.includes('googleusercontent.com') || 
									lower.includes('storage.googleapis.com') ||
									lower.includes('lh3.google') ||
									lower.includes('labs.google') ||
									lower.includes('gstatic.com') ||
									lower.startsWith('blob:');
				
				// Hoặc ảnh lớn bất kỳ (output từ AI)
				const isLargeImg = img.naturalWidth >= 300 && img.naturalHeight >= 300;

				if (isGoogleImg || isLargeImg) {
					const baseURL = src.split('?')[0];
					if (!seen.has(baseURL)) {
						seen.add(baseURL);
						result.push(src);
					}
				}
			}

			// Cũng kiểm tra canvas elements (một số AI dùng canvas để render)
			const canvases = document.querySelectorAll('canvas');
			for (const canvas of canvases) {
				if (canvas.width >= 300 && canvas.height >= 300) {
					try {
						const dataURL = canvas.toDataURL('image/png');
						if (dataURL && dataURL.length > 1000) {
							result.push(dataURL);
						}
					} catch(e) {}
				}
			}

			return result;
		})()
	`, &urls))
	return urls
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Download
// ─────────────────────────────────────────────────────────────────────────────

// downloadViaJS tải ảnh qua JavaScript trong browser
// Strategy: 1) Canvas draw (bypass CORS vì img đã render) 2) Fetch with credentials
func (g *GoogleFlowChrome) downloadViaJS(ctx context.Context, imageURL, outputPath string) error {
	// Xử lý data: URL (từ canvas)
	if strings.HasPrefix(imageURL, "data:") {
		parts := strings.SplitN(imageURL, ",", 2)
		if len(parts) < 2 {
			return fmt.Errorf("data URL không hợp lệ")
		}
		data, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return fmt.Errorf("decode data URL lỗi: %w", err)
		}
		return os.WriteFile(outputPath, data, 0644)
	}

	// === Strategy 1: Tìm img element trong DOM và draw vào canvas ===
	// Cách này bypass CORS vì img đã được load và render trên trang
	log.Printf("GoogleFlow: [Download] Thử canvas draw cho: %s", truncate(imageURL, 80))
	var b64Data string
	err := chromedp.Run(ctx, chromedp.Evaluate(
		fmt.Sprintf(`
			(async function() {
				try {
					// Tìm img element có src khớp
					const imgs = document.querySelectorAll('img[src]');
					for (const img of imgs) {
						if (img.src === %q || img.src.split('?')[0] === %q) {
							// Vẽ img vào canvas
							const canvas = document.createElement('canvas');
							canvas.width = img.naturalWidth || img.width;
							canvas.height = img.naturalHeight || img.height;
							if (canvas.width < 10 || canvas.height < 10) continue;
							
							const ctx2d = canvas.getContext('2d');
							ctx2d.drawImage(img, 0, 0);
							
							try {
								const dataUrl = canvas.toDataURL('image/png');
								if (dataUrl && dataUrl.length > 1000) {
									return dataUrl.split(',')[1] || '';
								}
							} catch(e) {
								// CORS tainted canvas — thử strategy khác
								continue;
							}
						}
					}
					return '';
				} catch(e) { return ''; }
			})()
		`, imageURL, strings.Split(imageURL, "?")[0]),
		&b64Data,
		func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
			return p.WithAwaitPromise(true)
		},
	))

	if err == nil && b64Data != "" {
		data, decErr := base64.StdEncoding.DecodeString(b64Data)
		if decErr == nil && len(data) > 100 {
			log.Printf("GoogleFlow: ✅ Canvas download thành công (%d KB)", len(data)/1024)
			return os.WriteFile(outputPath, data, 0644)
		}
	}

	// === Strategy 2: Fetch with credentials (same-origin) ===
	log.Println("GoogleFlow: [Download] Canvas failed, thử fetch with credentials...")
	err = chromedp.Run(ctx, chromedp.Evaluate(
		fmt.Sprintf(`
			(async function() {
				try {
					const r = await fetch(%q, {
						credentials: 'include',
						mode: 'cors',
						headers: { 'Referer': 'https://labs.google/' }
					});
					if (!r.ok) return '';
					const blob = await r.blob();
					return await new Promise(resolve => {
						const reader = new FileReader();
						reader.onloadend = () => {
							resolve((reader.result || '').split(',')[1] || '');
						};
						reader.readAsDataURL(blob);
					});
				} catch(e) { return ''; }
			})()
		`, imageURL),
		&b64Data,
		func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
			return p.WithAwaitPromise(true)
		},
	))

	if err != nil {
		return fmt.Errorf("JS eval lỗi: %w", err)
	}
	if b64Data == "" {
		// === Strategy 3: Load img with crossOrigin và draw lại ===
		log.Println("GoogleFlow: [Download] Fetch failed, thử crossOrigin img load...")
		err = chromedp.Run(ctx, chromedp.Evaluate(
			fmt.Sprintf(`
				(async function() {
					try {
						return await new Promise((resolve) => {
							const img = new Image();
							img.crossOrigin = 'anonymous';
							img.onload = () => {
								const canvas = document.createElement('canvas');
								canvas.width = img.naturalWidth;
								canvas.height = img.naturalHeight;
								canvas.getContext('2d').drawImage(img, 0, 0);
								try {
									const d = canvas.toDataURL('image/png');
									resolve(d.split(',')[1] || '');
								} catch(e) { resolve(''); }
							};
							img.onerror = () => resolve('');
							img.src = %q;
							setTimeout(() => resolve(''), 15000);
						});
					} catch(e) { return ''; }
				})()
			`, imageURL),
			&b64Data,
			func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithAwaitPromise(true)
			},
		))
		if err != nil || b64Data == "" {
			return fmt.Errorf("tất cả download strategies đều thất bại")
		}
	}

	data, err := base64.StdEncoding.DecodeString(b64Data)
	if err != nil {
		return fmt.Errorf("decode base64 lỗi: %w", err)
	}
	log.Printf("GoogleFlow: ✅ Download thành công (%d KB)", len(data)/1024)
	return os.WriteFile(outputPath, data, 0644)
}

// downloadImageHTTP tải ảnh qua HTTP GET
func downloadImageHTTP(imageURL, imgDir, thumbDir, fileName string) (string, error) {
	if strings.HasPrefix(imageURL, "blob:") || strings.HasPrefix(imageURL, "data:") {
		return "", fmt.Errorf("blob/data URL cần download qua JS")
	}

	outputPath := filepath.Join(imgDir, fileName)

	client := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequest("GET", imageURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://labs.google/")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("không thể download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(outputPath, data, 0644); err != nil {
		return "", err
	}

	// Thumbnail
	if thumbDir != "" {
		thumbName := strings.TrimSuffix(fileName, filepath.Ext(fileName)) + ".jpg"
		_ = os.WriteFile(filepath.Join(thumbDir, thumbName), data, 0644)
	}

	log.Printf("GoogleFlow: 💾 Đã lưu: %s (%d KB)", fileName, len(data)/1024)
	return fileName, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func sameSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

func cleanFileName(prompt string) string {
	s := strings.ToLower(prompt)
	result := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}
		return '_'
	}, s)
	result = strings.Trim(result, "_")
	for strings.Contains(result, "__") {
		result = strings.ReplaceAll(result, "__", "_")
	}
	if len(result) > 30 {
		result = result[:30]
	}
	return result
}

func escapeSelector(sel string) string {
	return strings.ReplaceAll(sel, "'", "\\'")
}
