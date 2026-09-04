package grok

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

// GrokConfig chứa cấu hình cho Grok generation
type GrokConfig struct {
	Output     string
	AlbumID    string
	Prompts    []string
	Download   bool
	Suffix     string // Hậu tố thêm vào cuối mỗi prompt
	Count      int    // Số ảnh mỗi prompt (mặc định 4)
	UseImagine bool   // Dùng trang /imagine riêng (ko cần prefix "Generate N images")
}

// GrokImage đại diện cho ảnh được tạo
type GrokImage struct {
	URL    string
	Prompt string
	File   string
}

// StatusCallback để report tiến độ về frontend
type StatusCallback func(current, total int, msg string, isError bool)

// GrokChrome quản lý singleton Chrome instance
type GrokChrome struct {
	mu          sync.Mutex
	allocCtx    context.Context
	allocCancel context.CancelFunc
	ctx         context.Context
	cancel      context.CancelFunc
	running     bool
}

var instance = &GrokChrome{}

// GetInstance trả về singleton GrokChrome
func GetInstance() *GrokChrome {
	return instance
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// Start khởi động Chrome và mở grok.com
func (g *GrokChrome) Start(parentCtx context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.running {
		return nil
	}

	profileDir := "grok_profile"
	if err := os.MkdirAll(profileDir, 0755); err != nil {
		log.Printf("Grok: Không thể tạo thư mục profile: %v", err)
	}
	absProfile, _ := filepath.Abs(profileDir)

	opts := append(
		chromedp.DefaultExecAllocatorOptions[3:],
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.Flag("headless", false),
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.Flag("disable-extensions", false),
		chromedp.UserDataDir(absProfile),
		chromedp.WindowSize(1280, 900),
	)

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
		log.Println("Grok Chrome: Đang mở grok.com...")
		if err := chromedp.Run(ctx, chromedp.Navigate("https://grok.com")); err != nil {
			if !strings.Contains(err.Error(), "context canceled") {
				log.Printf("Grok Chrome: Lỗi navigate: %v", err)
			}
			return
		}
		log.Println("Grok Chrome: Đã mở grok.com. Hãy đăng nhập nếu cần.")
	}()

	return nil
}

// Stop đóng Chrome
func (g *GrokChrome) Stop() {
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
	log.Println("Grok Chrome: Đã tắt.")
}

// IsRunning kiểm tra Chrome có đang chạy không
func (g *GrokChrome) IsRunning() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.running
}

func (g *GrokChrome) getCtx() context.Context {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Generation
// ─────────────────────────────────────────────────────────────────────────────

// GenerateBatch chạy tất cả prompt trong 1 session chat duy nhất
func (g *GrokChrome) GenerateBatch(cfg *GrokConfig, onProgress StatusCallback) ([]*GrokImage, error) {
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
		onProgress(0, total, "Đang điều hướng đến trang tạo ảnh Grok...", false)
	}

	// Navigate 1 lần duy nhất
	if err := g.navigateToImagePage(ctx, cfg.UseImagine); err != nil {
		return nil, err
	}
	if err := g.waitForReady(ctx); err != nil {
		return nil, err
	}

	var allImages []*GrokImage
	// Track URLs đã xử lý để phân biệt ảnh mới vs ảnh cũ trong cùng session
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

		imgs, err := g.generateOne(ctx, prompt, i, imgDir, thumbDir, cfg.Download, cfg.Suffix, cfg.Count, cfg.UseImagine, processedURLs, onProgress, i, total)
		if err != nil {
			log.Printf("Grok: Lỗi prompt %d: %v", i, err)
			if onProgress != nil {
				onProgress(i+1, total, fmt.Sprintf("[%d/%d] ❌ Lỗi: %v", i+1, total, err), true)
			}
		} else {
			allImages = append(allImages, imgs...)
			// Đánh dấu URLs đã xử lý
			for _, img := range imgs {
				processedURLs[img.URL] = true
			}
			if onProgress != nil {
				onProgress(i+1, total, fmt.Sprintf("[%d/%d] ✅ Xong — %d ảnh", i+1, total, len(imgs)), false)
			}
		}

		// Chờ 2 giây giữa các prompt (trong cùng session)
		if i < total-1 {
			time.Sleep(2 * time.Second)
		}
	}

	return allImages, nil
}

// navigateToImagePage điều hướng đến trang chat mới trên grok.com
func (g *GrokChrome) navigateToImagePage(ctx context.Context, useImagine bool) error {
	var targetURL string
	if useImagine {
		targetURL = "https://grok.com/imagine"
		log.Println("Grok: Đang mở trang /imagine...")
	} else {
		targetURL = "https://grok.com"
		log.Println("Grok: Đang mở trang chính...")
	}

	err := chromedp.Run(ctx, chromedp.Navigate(targetURL))
	if err != nil {
		return fmt.Errorf("không thể navigate %s: %w", targetURL, err)
	}
	time.Sleep(2 * time.Second)
	return nil
}

// waitForReady chờ trang load xong và input sẵn sàng (tối đa 3 phút)
func (g *GrokChrome) waitForReady(ctx context.Context) error {
	log.Println("Grok: Đang chờ trang sẵn sàng...")
	deadline := time.Now().Add(3 * time.Minute)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("đã hủy")
		case <-time.After(1 * time.Second):
		}

		var inputInfo string
		_ = chromedp.Run(ctx, chromedp.Evaluate(`
			(function() {
				// 1. ProseMirror/TipTap (grok.com dùng cái này)
				const pm = document.querySelector('div.ProseMirror[contenteditable="true"]');
				if (pm && pm.offsetParent !== null) return 'prosemirror:' + (pm.getAttribute('aria-label') || 'ok');

				// 2. Textarea
				const ta = document.querySelector('textarea');
				if (ta && ta.offsetParent !== null) return 'textarea:' + (ta.placeholder || 'ok');

				// 3. Generic contenteditable
				const ce = document.querySelector('[contenteditable="true"]');
				if (ce && ce.offsetParent !== null) return 'contenteditable:' + (ce.getAttribute('aria-label') || 'ok');

				// 4. Role textbox
				const tb = document.querySelector('div[role="textbox"]');
				if (tb && tb.offsetParent !== null) return 'textbox:ok';

				// 5. Input text
				const inp = document.querySelector('input[type="text"]:not([type="hidden"])');
				if (inp && inp.offsetParent !== null) return 'input:' + (inp.placeholder || 'ok');

				return '';
			})()
		`, &inputInfo))

		if inputInfo != "" {
			log.Printf("Grok: Trang sẵn sàng! Input type: %s", inputInfo)
			return nil
		}

		// Kiểm tra có đang ở trang login không
		var isLoginPage bool
		_ = chromedp.Run(ctx, chromedp.Evaluate(`
			window.location.href.includes('login') || 
			window.location.href.includes('signin') ||
			document.title.toLowerCase().includes('sign in')
		`, &isLoginPage))

		if isLoginPage {
			log.Println("Grok: Đang ở trang đăng nhập — vui lòng đăng nhập thủ công...")
		}
	}

	return fmt.Errorf("timeout: không tìm thấy input sau 3 phút")
}

// generateOne xử lý 1 prompt hoàn chỉnh trong cùng session chat:
// Submit → Đợi ảnh MỚI render full trong DOM → Get URLs → Download
func (g *GrokChrome) generateOne(
	ctx context.Context,
	prompt string,
	promptIdx int,
	imgDir, thumbDir string,
	doDownload bool,
	suffix string,
	imgCount int,
	useImagine bool,
	processedURLs map[string]bool,
	onProgress StatusCallback,
	current, total int,
) ([]*GrokImage, error) {

	// Số ảnh mặc định là 4
	if imgCount <= 0 {
		imgCount = 4
	}

	// Tạo prompt đầy đủ
	var fullPrompt string
	if useImagine {
		// Trang /imagine tự xử lý tạo ảnh — không cần prefix
		fullPrompt = prompt
	} else {
		// Trang chính cần instruction rõ ràng
		fullPrompt = fmt.Sprintf("Generate %d images: %s", imgCount, prompt)
	}
	if suffix != "" {
		fullPrompt = fullPrompt + " " + suffix
	}

	// ── 1. Type prompt vào input và submit ────────────────────────────────
	if onProgress != nil {
		onProgress(current, total, fmt.Sprintf("[%d/%d] ⌨️ Đang gõ prompt (yêu cầu %d ảnh)...", current+1, total, imgCount), false)
	}
	g.trySetImageCount4(ctx)
	if err := g.typePromptAndSubmit(ctx, fullPrompt); err != nil {
		return nil, err
	}

	// ── 2. Chờ ảnh MỚI render đầy đủ trong DOM ─────────────────────────
	if onProgress != nil {
		onProgress(current, total, fmt.Sprintf("[%d/%d] ⏳ Đang chờ Grok tạo %d ảnh & hiện hình full...", current+1, total, imgCount), false)
	}
	imageURLs := g.waitForNewImages(ctx, imgCount, processedURLs)
	if len(imageURLs) == 0 {
		return nil, fmt.Errorf("không tìm thấy ảnh mới nào trong DOM sau khi chờ")
	}
	log.Printf("Grok: ✅ Tìm thấy %d ảnh MỚI đã render đầy đủ cho prompt #%d", len(imageURLs), promptIdx)

	// ── 5. Download ảnh ────────────────────────────────────────────────────
	var images []*GrokImage
	for i, u := range imageURLs {
		ext := ".jpg"
		if strings.Contains(u, ".png") {
			ext = ".png"
		} else if strings.Contains(u, ".webp") {
			ext = ".webp"
		}
		cleanName := cleanFileName(prompt)
		fileName := fmt.Sprintf("grok_%s_%05d_%02d%s", cleanName, promptIdx, i, ext)
		img := &GrokImage{URL: u, Prompt: prompt, File: fileName}

		if doDownload {
			if onProgress != nil {
				onProgress(current, total, fmt.Sprintf("[%d/%d] 📥 Download ảnh %d/%d...", current+1, total, i+1, len(imageURLs)), false)
			}
			outPath := filepath.Join(imgDir, fileName)
			if err := g.downloadViaJS(ctx, u, outPath); err != nil {
				log.Printf("Grok: JS download thất bại (%v), thử HTTP...", err)
				if _, err2 := downloadImageHTTP(u, imgDir, thumbDir, fileName); err2 != nil {
					log.Printf("Grok: ❌ Không download được ảnh %d: %v", i, err2)
					continue
				}
			} else {
				log.Printf("Grok: 💾 Đã lưu: %s", fileName)
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
// Input & Submit — Phần quan trọng nhất
// ─────────────────────────────────────────────────────────────────────────────

// trySetImageCount4 cố gắng click nút để tăng số ảnh lên 4 (nếu Grok hỗ trợ)
func (g *GrokChrome) trySetImageCount4(ctx context.Context) {
	var clicked bool
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// Tìm số nút chứa số 4 hoặc aria-label="4 images"
			const allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"]'));
			
			// Thử tìm theo text "4"
			const btn4 = allBtns.find(b => {
				const txt = (b.textContent || '').trim();
				const label = (b.getAttribute('aria-label') || '').toLowerCase();
				return txt === '4' || label.includes('4 image') || label === '4';
			});
			
			if (btn4 && !btn4.disabled) {
				btn4.click();
				return true;
			}
			
			// Tìm count selector (dropdown)
			const sel = document.querySelector('select[name*="count"], select[name*="image"], [class*="count"] select');
			if (sel) {
				sel.value = '4';
				sel.dispatchEvent(new Event('change', {bubbles: true}));
				return true;
			}
			
			return false;
		})()
	`, &clicked))
	if clicked {
		log.Println("Grok: Đã set số ảnh = 4")
		time.Sleep(300 * time.Millisecond)
	}
}

// typePromptAndSubmit: tìm input → xóa nội dung cũ → gõ prompt → Enter
// Grok dùng TipTap/ProseMirror editor (div.ProseMirror contenteditable) với nội dung trong thẻ <p>
func (g *GrokChrome) typePromptAndSubmit(ctx context.Context, prompt string) error {
	// prompt đã bao gồm suffix (nếu có) — được nối sẵn từ generateOne
	fullPrompt := prompt

	log.Printf("Grok: Chuẩn bị submit: %s", truncate(fullPrompt, 80))

	// ── Bước A: Tìm input — ưu tiên ProseMirror ─────────────────────────────
	var inputInfo string
	err := chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// 1. ProseMirror/TipTap (grok.com dùng cái này — div.ProseMirror[contenteditable])
			const pm = document.querySelector('div.ProseMirror[contenteditable="true"]');
			if (pm && pm.offsetParent !== null) return 'prosemirror:div.ProseMirror[contenteditable="true"]';

			// 2. Textarea
			const ta = document.querySelector('textarea');
			if (ta && ta.offsetParent !== null) return 'textarea:textarea';

			// 3. Generic contenteditable
			const ce = document.querySelector('[contenteditable="true"]');
			if (ce && ce.offsetParent !== null) return 'contenteditable:[contenteditable="true"]';

			// 4. Role textbox
			const tb = document.querySelector('div[role="textbox"]');
			if (tb && tb.offsetParent !== null) return 'textbox:div[role="textbox"]';

			return '';
		})()
	`, &inputInfo))

	if err != nil || inputInfo == "" {
		var currentURL string
		_ = chromedp.Run(ctx, chromedp.Evaluate(`window.location.href`, &currentURL))
		log.Printf("Grok: Không tìm thấy input! URL = %s", currentURL)
		return fmt.Errorf("không tìm thấy ô nhập prompt trên grok.com (URL: %s)", currentURL)
	}

	log.Printf("Grok: Tìm thấy input: %s", inputInfo)

	parts := strings.SplitN(inputInfo, ":", 2)
	if len(parts) < 2 {
		return fmt.Errorf("input info không hợp lệ: %s", inputInfo)
	}
	editorType := parts[0] // "prosemirror", "textarea", "contenteditable", "textbox"
	sel := parts[1]

	// ── Bước B: Click vào input để focus ─────────────────────────────────────
	if err := chromedp.Run(ctx, chromedp.Click(sel, chromedp.ByQuery)); err != nil {
		log.Printf("Grok: Không click được, thử JS focus: %v", err)
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(
			`document.querySelector('%s')?.focus()`, escapeSelector(sel),
		), nil))
	}
	time.Sleep(500 * time.Millisecond)

	// ── Bước C: Nhập prompt ──────────────────────────────────────────────────
	inserted := false

	if editorType == "prosemirror" || editorType == "contenteditable" || editorType == "textbox" {
		// ═══════════════════════════════════════════════════════════════════════
		// ProseMirror/TipTap — cần phương pháp đặc biệt vì nó quản lý state riêng
		// Nội dung nằm trong thẻ <p>, KHÔNG phải .value
		// ═══════════════════════════════════════════════════════════════════════

		// === PM Strategy 1: Simulated ClipboardEvent paste ===
		// ProseMirror có built-in paste handler xử lý ClipboardEvent rất tốt
		log.Println("Grok: [PM Strategy 1] Simulated ClipboardEvent paste")
		var pasteOk bool
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
			(function() {
				const el = document.querySelector('%s');
				if (!el) return false;
				el.focus();

				// Xóa nội dung cũ
				document.execCommand('selectAll', false, null);
				document.execCommand('delete', false, null);

				// Tạo ClipboardEvent giả với DataTransfer chứa prompt
				const dt = new DataTransfer();
				dt.setData('text/plain', %q);
				const pasteEvent = new ClipboardEvent('paste', {
					bubbles: true,
					cancelable: true,
					clipboardData: dt
				});
				el.dispatchEvent(pasteEvent);
				return true;
			})()
		`, escapeSelector(sel), fullPrompt), &pasteOk))
		if pasteOk {
			time.Sleep(800 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, fullPrompt)
		}

		// === PM Strategy 2: execCommand insertText ===
		// Một số ProseMirror versions vẫn handle execCommand
		if !inserted {
			log.Println("Grok: [PM Strategy 2] execCommand insertText")
			_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
				(function() {
					const el = document.querySelector('%s');
					if (!el) return;
					el.focus();
					document.execCommand('selectAll', false, null);
					document.execCommand('delete', false, null);
					document.execCommand('insertText', false, %q);
				})()
			`, escapeSelector(sel), fullPrompt), nil))
			time.Sleep(500 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, fullPrompt)
		}

		// === PM Strategy 3: InputEvent beforeinput ===
		// ProseMirror v1.28+ lắng nghe beforeinput event
		if !inserted {
			log.Println("Grok: [PM Strategy 3] beforeinput InputEvent")
			_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
				(function() {
					const el = document.querySelector('%s');
					if (!el) return;
					el.focus();

					// Xóa nội dung cũ
					el.dispatchEvent(new InputEvent('beforeinput', {
						bubbles: true, cancelable: true,
						inputType: 'deleteContentBackward'
					}));
					document.execCommand('selectAll', false, null);
					document.execCommand('delete', false, null);

					// Chèn text mới qua beforeinput
					el.dispatchEvent(new InputEvent('beforeinput', {
						bubbles: true,
						cancelable: true,
						inputType: 'insertText',
						data: %q
					}));
					// Sau đó dispatch input event
					el.dispatchEvent(new InputEvent('input', {
						bubbles: true,
						inputType: 'insertText',
						data: %q
					}));
				})()
			`, escapeSelector(sel), fullPrompt, fullPrompt), nil))
			time.Sleep(500 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, fullPrompt)
		}

		// === PM Strategy 4: chromedp.SendKeys ===
		// Phương pháp chậm nhất nhưng đáng tin cậy nhất vì tạo real keyboard events
		// mà ProseMirror xử lý tự nhiên
		if !inserted {
			log.Println("Grok: [PM Strategy 4] SendKeys (real keyboard events)")
			// Clear trước
			_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
				(function() {
					const el = document.querySelector('%s');
					if (!el) return;
					el.focus();
					document.execCommand('selectAll', false, null);
					document.execCommand('delete', false, null);
				})()
			`, escapeSelector(sel)), nil))
			time.Sleep(300 * time.Millisecond)

			if err := chromedp.Run(ctx, chromedp.SendKeys(sel, fullPrompt, chromedp.ByQuery)); err != nil {
				log.Printf("Grok: SendKeys thất bại: %v", err)
			} else {
				time.Sleep(500 * time.Millisecond)
				inserted = g.verifyInputContent(ctx, sel, fullPrompt)
			}
		}

	} else {
		// ═══════════════════════════════════════════════════════════════════════
		// Textarea — dùng nativeInputValueSetter (React pattern)
		// ═══════════════════════════════════════════════════════════════════════
		log.Println("Grok: [Textarea Strategy 1] nativeInputValueSetter + InputEvent")
		var setOk bool
		_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
			(function() {
				const el = document.querySelector('%s');
				if (!el) return false;
				el.focus();
				const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
				setter.call(el, '');
				el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
				setter.call(el, %q);
				el.dispatchEvent(new InputEvent('input', {
					bubbles: true, cancelable: true, inputType: 'insertText', data: %q
				}));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			})()
		`, escapeSelector(sel), fullPrompt, fullPrompt), &setOk))
		if setOk {
			time.Sleep(500 * time.Millisecond)
			inserted = g.verifyInputContent(ctx, sel, fullPrompt)
		}

		// Textarea fallback: SendKeys
		if !inserted {
			log.Println("Grok: [Textarea Strategy 2] SendKeys")
			_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(
				`(function(){
					const el = document.querySelector('%s');
					if(!el) return;
					el.focus();
					el.select();
				})()`, escapeSelector(sel),
			), nil))
			time.Sleep(300 * time.Millisecond)
			if err := chromedp.Run(ctx, chromedp.SendKeys(sel, fullPrompt, chromedp.ByQuery)); err != nil {
				log.Printf("Grok: SendKeys thất bại: %v", err)
			} else {
				time.Sleep(500 * time.Millisecond)
				inserted = g.verifyInputContent(ctx, sel, fullPrompt)
			}
		}
	}

	// === Universal Fallback: Clipboard paste ===
	if !inserted {
		log.Println("Grok: [Universal Fallback] Clipboard paste")
		_ = g.setValueViaClipboard(ctx, sel, fullPrompt)
		time.Sleep(600 * time.Millisecond)
		inserted = g.verifyInputContent(ctx, sel, fullPrompt)
	}

	// Log kết quả cuối cùng
	var finalContent string
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return '';
			// ProseMirror: nội dung nằm trong <p> tags, dùng innerText
			return (el.value || el.innerText || el.textContent || '').trim();
		})()
	`, escapeSelector(sel)), &finalContent))
	log.Printf("Grok: Nội dung cuối cùng trong input (%d chars): %s", len(finalContent), truncate(finalContent, 80))

	if !inserted {
		log.Println("Grok: ⚠️ Không chắc prompt đã được nhập đúng, nhưng vẫn thử submit...")
	}

	// ── Bước D: Submit ────────────────────────────────────────────────────────
	return g.submitForm(ctx, sel)
}

// setValueViaClipboard dùng JS clipboard API để paste text
func (g *GrokChrome) setValueViaClipboard(ctx context.Context, sel, text string) error {
	return chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(async function() {
			try {
				await navigator.clipboard.writeText(%q);
				const el = document.querySelector('%s');
				if (!el) return;
				el.focus();
				document.execCommand('selectAll', false, null);
				document.execCommand('paste');
			} catch(e) {
				// Fallback nếu clipboard không có quyền — dùng ClipboardEvent
				const el = document.querySelector('%s');
				if (!el) return;
				el.focus();
				document.execCommand('selectAll', false, null);
				document.execCommand('delete', false, null);
				const dt = new DataTransfer();
				dt.setData('text/plain', %q);
				el.dispatchEvent(new ClipboardEvent('paste', {
					bubbles: true, cancelable: true, clipboardData: dt
				}));
			}
		})()
	`, text, escapeSelector(sel), escapeSelector(sel), text), nil))
}

// verifyInputContent kiểm tra nội dung đã được nhập đúng vào input chưa
func (g *GrokChrome) verifyInputContent(ctx context.Context, sel, expected string) bool {
	var content string
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			const el = document.querySelector('%s');
			if (!el) return '';
			// ProseMirror: nội dung nằm trong <p> tags — ưu tiên innerText
			// Textarea: dùng .value
			const v = el.value || el.innerText || el.textContent || '';
			return v.trim();
		})()
	`, escapeSelector(sel)), &content))

	if len(content) < 3 {
		log.Printf("Grok: ❌ Verify FAILED — input rỗng hoặc quá ngắn: '%s'", truncate(content, 30))
		return false
	}

	// Kiểm tra có chứa ít nhất 1 phần của prompt (sau "Generate 4 images: ")
	expectedCore := expected
	if idx := strings.Index(expected, ": "); idx != -1 && idx < 30 {
		expectedCore = expected[idx+2:]
	}
	if len(expectedCore) > 20 {
		expectedCore = expectedCore[:20]
	}

	if strings.Contains(content, expectedCore) {
		log.Printf("Grok: ✅ Verify OK — prompt đã được nhập (%d chars)", len(content))
		return true
	}

	log.Printf("Grok: ❌ Verify FAILED — nội dung không khớp. Got: '%s'", truncate(content, 50))
	return false
}

// submitForm: nhấn nút Send hoặc Enter để submit
func (g *GrokChrome) submitForm(ctx context.Context, inputSel string) error {
	// Thử tìm và click nút Send/Submit
	var clicked bool
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// Tìm nút submit theo aria-label hoặc type
			const candidates = [
				document.querySelector('button[aria-label="Send message"]'),
				document.querySelector('button[aria-label*="Send"]'),
				document.querySelector('button[aria-label*="send"]'),
				document.querySelector('button[type="submit"]'),
				// Tìm button có SVG arrow icon gần input
				...Array.from(document.querySelectorAll('button')).filter(b => {
					const svg = b.querySelector('svg');
					const rect = b.getBoundingClientRect();
					return svg && rect.width > 0 && rect.height > 0 && !b.disabled;
				}),
			];
			
			for (const btn of candidates) {
				if (btn && !btn.disabled && btn.offsetParent !== null) {
					btn.click();
					return true;
				}
			}
			return false;
		})()
	`, &clicked))

	if clicked {
		log.Println("Grok: ✅ Đã click nút Send")
		return nil
	}

	// Fallback: nhấn Enter trong input
	log.Println("Grok: Không tìm thấy nút Send, nhấn Enter...")
	if err := chromedp.Run(ctx, chromedp.KeyEvent("\r")); err != nil {
		// Thử Shift+Enter rồi Enter
		_ = chromedp.Run(ctx, chromedp.Evaluate(`
			document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Enter', code: 'Enter', keyCode: 13,
				which: 13, bubbles: true, cancelable: true
			}))
		`, nil))
	}

	log.Println("Grok: ✅ Đã nhấn Enter")
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Collection — DOM-based (đợi ảnh render full rồi mới get)
// ─────────────────────────────────────────────────────────────────────────────

// waitForResponseComplete chờ Grok xử lý xong (không còn loading/spinner), tối đa 3 phút
func (g *GrokChrome) waitForResponseComplete(ctx context.Context, msgCountBefore int) error {
	log.Println("Grok: Đang chờ Grok response...")
	deadline := time.Now().Add(3 * time.Minute)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("đã hủy")
		case <-time.After(2 * time.Second):
		}

		if g.checkGenerationDone(ctx, msgCountBefore) {
			log.Println("Grok: ✅ Response đã hoàn thành (không còn loading/spinner)")
			return nil
		}
	}

	// Timeout nhưng vẫn thử lấy ảnh (có thể generation đã xong nhưng spinner chưa tắt)
	log.Println("Grok: ⚠️ Timeout chờ response, thử kiểm tra DOM...")
	return nil
}

// waitForNewImages chờ ảnh MỚI (chưa xử lý) render đầy đủ trong DOM
// Lọc bỏ ảnh đã có từ prompt trước (processedURLs), chỉ đếm ảnh mới
func (g *GrokChrome) waitForNewImages(ctx context.Context, expectedCount int, processedURLs map[string]bool) []string {
	log.Printf("Grok: Đang chờ %d ảnh MỚI render trong DOM (đã có %d ảnh cũ)...", expectedCount, len(processedURLs))
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

		// Lấy TẤT CẢ ảnh trong DOM
		allURLs := g.getFullyLoadedImages(ctx)

		// Lọc chỉ lấy ảnh MỚI (chưa có trong processedURLs)
		var newURLs []string
		for _, u := range allURLs {
			if !processedURLs[u] {
				newURLs = append(newURLs, u)
			}
		}

		// Ghi nhận thời điểm tìm thấy ảnh mới đầu tiên
		if len(newURLs) > 0 && firstImageTime.IsZero() {
			firstImageTime = time.Now()
			log.Printf("Grok: 📸 Phát hiện %d ảnh MỚI đầu tiên, chờ đủ %d ảnh...", len(newURLs), expectedCount)
		}

		if len(newURLs) > 0 {
			if len(newURLs) == len(lastNewURLs) && sameSlice(newURLs, lastNewURLs) {
				stableCount++

				// Đủ số ảnh mong đợi và ổn định 2 lần (6s)
				if len(newURLs) >= expectedCount && stableCount >= 2 {
					log.Printf("Grok: ✅ Đủ %d/%d ảnh MỚI và ổn định!", len(newURLs), expectedCount)
					if len(newURLs) > expectedCount {
						newURLs = newURLs[:expectedCount]
					}
					return newURLs
				}

				// Chưa đủ — chờ thêm tối đa 30s sau ảnh đầu tiên
				if len(newURLs) < expectedCount && !firstImageTime.IsZero() && time.Since(firstImageTime) > 30*time.Second && stableCount >= 3 {
					log.Printf("Grok: ⚠️ Chỉ có %d/%d ảnh MỚI sau 30s, lấy luôn", len(newURLs), expectedCount)
					return newURLs
				}

				log.Printf("Grok: DOM scan: %d/%d ảnh MỚI (đợi thêm...)", len(newURLs), expectedCount)
			} else {
				stableCount = 0
				log.Printf("Grok: DOM scan: %d/%d ảnh MỚI (đang load thêm...)", len(newURLs), expectedCount)
			}
			lastNewURLs = newURLs
		}
	}

	if len(lastNewURLs) > 0 {
		log.Printf("Grok: ⏰ Timeout nhưng có %d ảnh MỚI, sử dụng luôn", len(lastNewURLs))
		if len(lastNewURLs) > expectedCount {
			lastNewURLs = lastNewURLs[:expectedCount]
		}
	}
	return lastNewURLs
}

// getFullyLoadedImages lấy URLs ảnh đã load đầy đủ trong DOM.
// Bắt buộc lấy từ các nguồn ảnh generated thực tế của Grok trên trang imagine:
// - https://imagine-public.x.ai/imagine-public/images/...
// - https://assets.grok.com/users/.../generated/.../image.jpg?cache=1
// và bỏ qua favicon/logo/avatar/icon UI assets.
func (g *GrokChrome) getFullyLoadedImages(ctx context.Context) []string {
	var urls []string
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			const result = [];
			const seen = new Set();
			const candidateNodes = [
				...document.querySelectorAll('button[aria-label*="Open saved image"] img'),
				...document.querySelectorAll('a[href*="/imagine/post/"] img'),
				...document.querySelectorAll('img[src*="imagine-public.x.ai"], img[src*="assets.grok.com/users/"], img[src*="/generated/"], img[src*="/images/"]')
			];
			for (const node of candidateNodes) {
				const src = (node.currentSrc || node.src || '').trim();
				if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;

				const clean = src.split('?')[0].split('#')[0];
				const lower = clean.toLowerCase();
				const isGeneratedAsset =
					lower.includes('imagine-public.x.ai/imagine-public/images/') ||
					(lower.includes('assets.grok.com/users/') && lower.includes('/generated/')) ||
					((lower.includes('grok.com') || lower.includes('.grok.com') || lower.includes('x.ai')) &&
						(lower.includes('/generated/') || lower.includes('/images/') || lower.includes('/uploads/') || lower.includes('/media/') || lower.includes('/output/')));
				const isRenderableImage = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(lower);
				if (!isGeneratedAsset && !isRenderableImage) continue;
				if (!node.complete || node.naturalWidth <= 200 || node.naturalHeight <= 200) continue;
				if (lower.includes('favicon') || lower.includes('logo') || lower.includes('avatar') || lower.includes('icon') || lower.includes('sprite') || lower.includes('.svg')) continue;
				if (!seen.has(clean)) {
					seen.add(clean);
					// Luôn push URL đã chuẩn hoá (không có query params)
					// để processedURLs comparison hoạt động nhất quán
					result.push(clean);
				}
			}
			return result;
		})()
	`, &urls))
	return urls
}

// sameSlice kiểm tra 2 slice string có cùng tập hợp phần tử không (không phụ thuộc thứ tự)
// Dùng Set-comparison để tránh false reset khi DOM reorder URLs giữa các lần scan
func sameSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	setA := make(map[string]bool, len(a))
	for _, v := range a {
		setA[v] = true
	}
	for _, v := range b {
		if !setA[v] {
			return false
		}
	}
	return true
}

// deleteCurrentChat xóa chat hiện tại trên Grok
func (g *GrokChrome) deleteCurrentChat(ctx context.Context) {
	log.Println("Grok: Đang xóa chat hiện tại...")

	// Bước 1: Tìm và click nút menu (...) cho conversation hiện tại trong sidebar
	var menuResult string
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// Tìm conversation item đang active trong sidebar
			// Hover lên nó để hiện nút menu
			const activeItems = document.querySelectorAll(
				'a[class*="bg-"], nav a[aria-current], [class*="active"] a, [class*="selected"]'
			);
			
			for (const item of activeItems) {
				// Dispatch mouseover để hiện nút menu (nếu bị ẩn)
				item.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
				item.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
			}
			
			// Tìm nút options/menu gần conversation active
			const menuBtns = Array.from(document.querySelectorAll('button')).filter(b => {
				const label = (b.getAttribute('aria-label') || '').toLowerCase();
				const testid = (b.getAttribute('data-testid') || '').toLowerCase();
				return label.includes('more') || label.includes('option') || 
				       label.includes('menu') || label.includes('action') ||
				       testid.includes('more') || testid.includes('option') ||
				       testid.includes('menu');
			});
			
			if (menuBtns.length > 0) {
				// Click nút menu cuối cùng (thường là conversation hiện tại)
				menuBtns[menuBtns.length - 1].click();
				return 'menu_clicked';
			}
			
			// Thử hover lên tất cả conversation items và tìm lại
			const navLinks = document.querySelectorAll('nav a, aside a');
			for (const link of navLinks) {
				link.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
			}
			
			return 'no_menu';
		})()
	`, &menuResult))

	if menuResult != "menu_clicked" {
		log.Println("Grok: Không tìm thấy menu chat, bỏ qua xóa")
		return
	}

	// Bước 2: Đợi menu mở rồi click Delete
	time.Sleep(800 * time.Millisecond)

	var deleteClicked bool
	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// Tìm nút Delete/Xóa trong dropdown menu
			const items = Array.from(document.querySelectorAll(
				'[role="menuitem"], [role="option"], [data-testid*="delete"], button, div[class*="menu"] div'
			));
			const deleteBtn = items.find(el => {
				const text = (el.textContent || '').toLowerCase().trim();
				const label = (el.getAttribute('aria-label') || '').toLowerCase();
				const testid = (el.getAttribute('data-testid') || '').toLowerCase();
				return text.includes('delete') || text.includes('xóa') || text.includes('remove') ||
				       label.includes('delete') || testid.includes('delete');
			});
			if (deleteBtn) {
				deleteBtn.click();
				return true;
			}
			return false;
		})()
	`, &deleteClicked))

	if !deleteClicked {
		log.Println("Grok: Không tìm thấy nút Delete trong menu")
		// Đóng menu bằng Escape
		_ = chromedp.Run(ctx, chromedp.KeyEvent("\x1b")) // Escape
		return
	}

	// Bước 3: Confirm deletion dialog (nếu có)
	time.Sleep(800 * time.Millisecond)

	_ = chromedp.Run(ctx, chromedp.Evaluate(`
		(function() {
			// Tìm nút Confirm/Delete trong dialog xác nhận
			const btns = Array.from(document.querySelectorAll(
				'[role="dialog"] button, [class*="modal"] button, [class*="dialog"] button, button'
			));
			const confirmBtn = btns.find(b => {
				const text = (b.textContent || '').toLowerCase().trim();
				const cls = (b.className || '').toLowerCase();
				// Nút xóa thường có màu đỏ (danger/destructive) hoặc text "delete"
				return (text === 'delete' || text === 'confirm' || text === 'ok' || text === 'yes' || text === 'xóa') &&
				       (cls.includes('danger') || cls.includes('destructive') || cls.includes('red') || 
				        cls.includes('primary') || cls.includes('confirm') || text === 'delete');
			});
			if (confirmBtn) {
				confirmBtn.click();
				return true;
			}
			// Fallback: click bất kỳ nút nào có text delete/confirm
			const fallback = btns.find(b => {
				const text = (b.textContent || '').toLowerCase().trim();
				return text === 'delete' || text === 'xóa';
			});
			if (fallback) {
				fallback.click();
				return true;
			}
			return false;
		})()
	`, nil))

	time.Sleep(1 * time.Second)
	log.Println("Grok: ✅ Đã xóa chat")
}

// checkGenerationDone kiểm tra Grok có còn đang generate không
func (g *GrokChrome) checkGenerationDone(ctx context.Context, msgCountBefore int) bool {
	var isDone bool
	_ = chromedp.Run(ctx, chromedp.Evaluate(fmt.Sprintf(`
		(function() {
			// Loading indicators
			const loaders = document.querySelectorAll(
				'[class*="loading"], [class*="spinner"], svg.animate-spin, ' +
				'[class*="thinking"], [class*="generating"], [data-testid*="loading"]'
			);
			// Stop button (đang stream)
			const stopBtns = Array.from(document.querySelectorAll('button')).filter(b =>
				(b.getAttribute('aria-label') || '').toLowerCase().includes('stop') ||
				(b.textContent || '').toLowerCase().trim() === 'stop'
			);
			// Message count
			const msgCount = document.querySelectorAll(
				'[data-message-id], article, [class*="message-content"]'
			).length;
			
			const isLoading = loaders.length > 0;
			const hasStop = stopBtns.length > 0;
			const hasNewMsg = msgCount > %d;
			
			return !isLoading && !hasStop && hasNewMsg;
		})()
	`, msgCountBefore), &isDone))
	return isDone
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Download
// ─────────────────────────────────────────────────────────────────────────────

// downloadImageHTTP tải ảnh qua HTTP GET thông thường
func downloadImageHTTP(imageURL, imgDir, thumbDir, fileName string) (string, error) {
	if strings.HasPrefix(imageURL, "blob:") {
		return "", fmt.Errorf("blob URL cần download qua JS")
	}

	outputPath := filepath.Join(imgDir, fileName)

	client := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequest("GET", imageURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://grok.com/")
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

	log.Printf("Grok: 💾 Đã lưu: %s (%d KB)", fileName, len(data)/1024)
	return fileName, nil
}

// downloadViaJS tải ảnh cookie-protected URL qua JavaScript trong browser
func (g *GrokChrome) downloadViaJS(ctx context.Context, imageURL, outputPath string) error {
	var b64Data string
	encodedURL := strings.ReplaceAll(imageURL, "\"", "\\\"")
	err := chromedp.Run(ctx, chromedp.Evaluate(
		fmt.Sprintf(`
			(async function() {
				try {
					const r = await fetch(%q, {
						credentials: 'include',
						mode: 'cors',
						headers: { 'Referer': 'https://grok.com/' }
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
				} catch (e) {
					try {
						const image = new Image();
						image.crossOrigin = 'anonymous';
						image.src = %q;
						await image.decode();
						const canvas = document.createElement('canvas');
						canvas.width = image.naturalWidth;
						canvas.height = image.naturalHeight;
						const ctx = canvas.getContext('2d');
						ctx.drawImage(image, 0, 0);
						return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] || '';
					} catch (_) {
						return '';
					}
				}
			})()
		`, imageURL, encodedURL),
		&b64Data,
		func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
			return p.WithAwaitPromise(true)
		},
	))

	if err != nil {
		return fmt.Errorf("JS eval lỗi: %w", err)
	}
	if b64Data == "" {
		return fmt.Errorf("JS trả về rỗng (có thể fetch thất bại hoặc không có quyền)")
	}
	data, err := base64.StdEncoding.DecodeString(b64Data)
	if err != nil {
		return fmt.Errorf("decode base64 lỗi: %w", err)
	}
	return os.WriteFile(outputPath, data, 0644)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// isGrokImageURL kiểm tra URL có phải ảnh generated từ Grok theo đúng nguồn ảnh trên trang Grok Imagine.
// Bắt buộc chấp nhận các pattern thực tế:
// - https://imagine-public.x.ai/imagine-public/images/....jpg
// - https://assets.grok.com/users/.../generated/.../image.jpg?cache=1
func isGrokImageURL(url string) bool {
	if len(url) < 20 {
		return false
	}
	lower := strings.ToLower(url)

	if strings.HasPrefix(lower, "data:image/") || strings.HasPrefix(lower, "blob:") {
		return false
	}

	// Loại bỏ UI assets (avatar, icon, logo, ...)
	excludes := []string{"favicon", "logo", "avatar", "icon", "sprite", ".svg", "pixel.gif", "analytics", "emoji", "profile"}
	for _, ex := range excludes {
		if strings.Contains(lower, ex) {
			return false
		}
	}

	if !strings.Contains(lower, "grok") && !strings.Contains(lower, "x.ai") {
		return false
	}

	if strings.Contains(lower, "imagine-public.x.ai/imagine-public/images/") {
		return true
	}

	if strings.Contains(lower, "assets.grok.com/users/") && strings.Contains(lower, "/generated/") {
		return true
	}

	if strings.Contains(lower, "/generated/") || strings.Contains(lower, "/images/") || strings.Contains(lower, "/uploads/") || strings.Contains(lower, "/media/") || strings.Contains(lower, "/output/") {
		return true
	}

	for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"} {
		if strings.Contains(lower, ext) {
			return true
		}
	}

	return false
}

func seenInSlice(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
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
