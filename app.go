package main

import (
	"BulkAI/pkg/bulkai"
	"BulkAI/pkg/grok"
	"BulkAI/pkg/session"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/minio/selfupdate"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/xuri/excelize/v2"
	"gopkg.in/yaml.v2"
)

// App struct
type App struct {
	ctx context.Context
}

// GrokGenerateConfig là config gửi từ frontend cho Grok generation
type GrokGenerateConfig struct {
	Prompts  []string `json:"prompts"`
	Ratio    string   `json:"ratio"`
	Count    int      `json:"count"`
	Output   string   `json:"output"`
	Album    string   `json:"album"`
	Download bool     `json:"download"`
	Suffix   string   `json:"suffix"`
}

// CurrentVersion is the current version of the application
const CurrentVersion = "v1.0.0"

// UpdateInfo struct for auto-update
type UpdateInfo struct {
	HasUpdate bool   `json:"has_update"`
	Version   string `json:"version"`
	URL       string `json:"url"`
	Changelog string `json:"changelog"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// FetchSession triggers the background chrome process to fetch discord tokens and save to session.yaml
func (a *App) FetchSession() string {
	err := session.Run(a.ctx, false, "session.yaml", "")
	if err != nil {
		return err.Error()
	}
	return "Success"
}

// SessionInfo is the session details passed to frontend
type SessionInfo struct {
	Connected bool   `json:"connected"`
	Username  string `json:"username"`
	Avatar    string `json:"avatar"`
}

// CheckSession returns true if session.yaml exists, along with user info
func (a *App) CheckSession() SessionInfo {
	data, err := os.ReadFile("session.yaml")
	if err == nil {
		var s bulkai.Session
		if err := yaml.Unmarshal(data, &s); err == nil {
			return SessionInfo{
				Connected: true,
				Username:  s.Username,
				Avatar:    s.Avatar,
			}
		}
	}
	return SessionInfo{Connected: false}
}

// Logout deletes the session.yaml file
func (a *App) Logout() string {
	err := os.Remove("session.yaml")
	if err != nil {
		return err.Error()
	}
	return "Success"
}

// GenerateImages launches the BulkAI generation process
func (a *App) GenerateImages(cfg bulkai.Config) string {
	// Load session.yaml
	data, err := os.ReadFile("session.yaml")
	if err == nil {
		var s bulkai.Session
		if err := yaml.Unmarshal(data, &s); err == nil {
			cfg.Session = s
		}
	}
	cfg.SessionFile = "session.yaml"

	if cfg.Album == "" {
		cfg.Album = time.Now().UTC().Format("20060102_150405")
	}

	go func() {
		err := bulkai.Generate(a.ctx, &cfg, bulkai.WithOnUpdate(func(status bulkai.Status) {
			// Emit status to frontend
			runtime.EventsEmit(a.ctx, "generation_progress", status)
		}))
		if err != nil {
			runtime.EventsEmit(a.ctx, "generation_error", err.Error())
		} else {
			runtime.EventsEmit(a.ctx, "generation_finished", cfg.Album)
		}
	}()
	return "Started"
}

// GetAlbumData reads the completed data.json 
func (a *App) GetAlbumData(outputDir string, albumID string) string {
	if albumID == "" || outputDir == "" {
		return ""
	}
	dataPath := filepath.Join(outputDir, albumID, "data.json")
	data, err := os.ReadFile(dataPath)
	if err != nil {
		return ""
	}
	return string(data)
}

// GalleryFolder represents an album folder
type GalleryFolder struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// GetGalleryFolders returns a list of albums in the output directory
func (a *App) GetGalleryFolders(outputDir string) []GalleryFolder {
	var folders []GalleryFolder
	if outputDir == "" {
		return folders
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return folders
	}
	for _, entry := range entries {
		if entry.IsDir() {
			folders = append(folders, GalleryFolder{
				Name: entry.Name(),
				Path: filepath.Join(outputDir, entry.Name()),
			})
		}
	}
	// Sort descending so newest is first
	for i := 0; i < len(folders)/2; i++ {
		j := float64(len(folders) - i - 1)
		folders[i], folders[int(j)] = folders[int(j)], folders[i]
	}
	return folders
}

// GalleryImage represents a thumbnail image with base64 data
type GalleryImage struct {
	Name   string `json:"name"`
	Base64 string `json:"base64"`
}

// GetGalleryImages returns base64 encoded thumbnails for a given folder
func (a *App) GetGalleryImages(outputDir string, folderName string) []GalleryImage {
	var images []GalleryImage
	if outputDir == "" || folderName == "" {
		return images
	}

	thumbDir := filepath.Join(outputDir, folderName, "images", "_thumbnails")
	entries, err := os.ReadDir(thumbDir)
	if err != nil {
		return images
	}

	for _, entry := range entries {
		if !entry.IsDir() && (filepath.Ext(entry.Name()) == ".jpg" || filepath.Ext(entry.Name()) == ".png") {
			imgPath := filepath.Join(thumbDir, entry.Name())
			data, err := os.ReadFile(imgPath)
			if err == nil {
				b64 := base64.StdEncoding.EncodeToString(data)
				images = append(images, GalleryImage{
					Name:   entry.Name(),
					Base64: "data:image/jpeg;base64," + b64,
				})
			}
		}
	}
	return images
}

// GetImageFullBase64 returns base64 encoded full size image
func (a *App) GetImageFullBase64(outputDir string, folderName string, thumbName string) string {
	if outputDir == "" || folderName == "" || thumbName == "" {
		return ""
	}

	// Remove .jpg from thumbnail name to find original base name
	base := strings.TrimSuffix(thumbName, filepath.Ext(thumbName))
	
	// Try possible original files in images folder
	fullPath := filepath.Join(outputDir, folderName, "images", base + ".png")
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		fullPath = filepath.Join(outputDir, folderName, "images", base + ".jpg")
	}

	data, err := os.ReadFile(fullPath)
	if err != nil {
		return ""
	}

	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

// DeleteImage deletes both the full size image and its thumbnail
func (a *App) DeleteImage(outputDir string, folderName string, thumbName string) string {
	if outputDir == "" || folderName == "" || thumbName == "" {
		return "Invalid parameters"
	}

	// Paths
	thumbPath := filepath.Join(outputDir, folderName, "images", "_thumbnails", thumbName)
	base := strings.TrimSuffix(thumbName, filepath.Ext(thumbName))
	
	// Full image paths to check
	fullPaths := []string{
		filepath.Join(outputDir, folderName, "images", base + ".png"),
		filepath.Join(outputDir, folderName, "images", base + ".jpg"),
	}

	// Delete thumbnail
	_ = os.Remove(thumbPath)

	// Delete full images
	for _, p := range fullPaths {
		_ = os.Remove(p)
	}

	return "Success"
}

// ExportGalleryReport generates an Excel file for the given album
func (a *App) ExportGalleryReport(outputDir string, albumID string, prefix string, geminiKey string) string {
	if albumID == "" || outputDir == "" || geminiKey == "" {
		return "Error: Missing parameters or Gemini API key"
	}

	albumPath := filepath.Join(outputDir, albumID)
	dataPath := filepath.Join(albumPath, "data.json")
	data, err := os.ReadFile(dataPath)
	if err != nil {
		return "Error reading data.json: " + err.Error()
	}

	var album bulkai.Album
	if err := json.Unmarshal(data, &album); err != nil {
		return "Error parsing data.json: " + err.Error()
	}

	// Create Excel
	f := excelize.NewFile()
	sheetName := "Sheet1"
	index, _ := f.NewSheet(sheetName)
	f.SetActiveSheet(index)

	// Set Headers
	headers := []string{"Filename", "Title", "Keywords", "Category", "Releases"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheetName, cell, h)
	}

	// Iterate images
	row := 2
	subjectRegex := regexp.MustCompile(`(?i)\[Subject:\s*([^\]]+)\]`)
	keywordCache := make(map[string]string) // Cache để lưu tags cho từng title

	for _, img := range album.Images {
		if img.File == "" {
			continue
		}

		// Verify file exists in images folder
		imgPath := filepath.Join(albumPath, "images", img.File)
		if _, err := os.Stat(imgPath); os.IsNotExist(err) {
			continue
		}

		// 1. Filename
		f.SetCellValue(sheetName, fmt.Sprintf("A%d", row), img.File)

		// 2. Title
		title := img.Prompt
		if prefix != "" {
			title = strings.TrimPrefix(title, prefix)
			title = strings.TrimSpace(title)
		}
		
		match := subjectRegex.FindStringSubmatch(title)
		if len(match) > 1 {
			title = strings.TrimSpace(match[1])
		} else {
			// First sentence logic: until first dot
			dotIdx := strings.Index(title, ".")
			if dotIdx != -1 {
				title = title[:dotIdx]
			}
			title = strings.TrimSpace(title)
		}
		// If prompt was cleaned but no dots, use original prompt (without prefix)
		f.SetCellValue(sheetName, fmt.Sprintf("B%d", row), title)

		// 3. Keywords via Gemini
		keywords := ""
		if title != "" {
			// Kiểm tra nếu title này đã được tạo keywords trước đó
			if cached, ok := keywordCache[title]; ok {
				keywords = cached
			} else {
				keywords = a.getGeminiKeywords(title, geminiKey)
				// Lưu vào cache để dùng cho ảnh sau có cùng title
				if keywords != "" {
					keywordCache[title] = keywords
				}
			}
		}
		f.SetCellValue(sheetName, fmt.Sprintf("C%d", row), keywords)

		// 4 & 5. Category & Releases - Empty headers
		f.SetCellValue(sheetName, fmt.Sprintf("D%d", row), "")
		f.SetCellValue(sheetName, fmt.Sprintf("E%d", row), "")

		row++
	}

	// Save file
	excelPath := filepath.Join(albumPath, fmt.Sprintf("report_%s.xlsx", albumID))
	if err := f.SaveAs(excelPath); err != nil {
		return "Error saving Excel: " + err.Error()
	}

	return "Success: " + excelPath
}

func (a *App) getGeminiKeywords(title string, key string) string {
	apiUrl := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=%s", key)

	prompt := fmt.Sprintf(`Act as a professional stock photographer's assistant.
Title: "%s"
Task: Generate exactly 40 descriptive English keywords.
Rules:
1. Keywords must be single words.
2. Separate keywords with commas.
3. Only list keywords.`, title)

	reqBody := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{"text": prompt},
				},
			},
		},
	}

	js, _ := json.Marshal(reqBody)
	resp, err := http.Post(apiUrl, "application/json", strings.NewReader(string(js)))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return ""
	}

	if len(result.Candidates) > 0 && len(result.Candidates[0].Content.Parts) > 0 {
		text := result.Candidates[0].Content.Parts[0].Text

		// 1. Tìm dấu hai chấm cuối cùng - Đây là vị trí phổ biến nhất mà AI dùng để phân tách lời dẫn và kết quả
		lastColon := strings.LastIndex(text, ":")
		var cleanText string
		if lastColon != -1 {
			cleanText = text[lastColon+1:]
		} else {
			// 2. Nếu không có dấu hai chấm, tìm vị trí có vẻ là bắt đầu danh sách (dấu phẩy đầu tiên)
			firstComma := strings.Index(text, ",")
			if firstComma != -1 {
				sub := text[:firstComma]
				lastNewline := strings.LastIndex(sub, "\n")
				if lastNewline != -1 {
					cleanText = text[lastNewline+1:]
				} else {
					cleanText = text
				}
			} else {
				cleanText = text
			}
		}

		// 3. Tách lọc kỹ lại từng tag
		lines := strings.Split(cleanText, "\n")
		var allTags []string
		for _, line := range lines {
			line = strings.TrimSpace(line)
			// Bỏ qua các dòng lời dẫn nếu chúng vẫn lọt qua (chứa từ tiếng Việt hoặc quá dài không phải tag)
			if line == "" || strings.Contains(line, "Chắc chắn") || strings.Contains(line, "đây là") {
				continue
			}
			
			parts := strings.Split(line, ",")
			for _, p := range parts {
				p = strings.TrimSpace(p)
				p = strings.Trim(p, ".! ") // Xóa dấu chấm, than, khoảng trắng dư
				// Chỉ lấy từ đơn (không chứa khoảng trắng) và không rỗng
				if p != "" && !strings.Contains(p, " ") {
					allTags = append(allTags, p)
				}
			}
		}

		// Đảm bảo chỉ lấy 40 tags
		if len(allTags) > 40 {
			allTags = allTags[:40]
		}

		return strings.Join(allTags, ", ")
	}

	return ""
}

// UpscaleImage performs 4x upscaling on a given image file
func (a *App) UpscaleImage(outputDir string, folderName string, thumbName string) string {
	if outputDir == "" || folderName == "" || thumbName == "" {
		return "Lỗi: Thiếu tham số đường dẫn."
	}

	// 1. Tìm đường dẫn file ảnh gốc thực tế
	base := strings.TrimSuffix(thumbName, filepath.Ext(thumbName))
	imagePath := filepath.Join(outputDir, folderName, "images", base+".png")
	if _, err := os.Stat(imagePath); os.IsNotExist(err) {
		imagePath = filepath.Join(outputDir, folderName, "images", base+".jpg")
		if _, err := os.Stat(imagePath); os.IsNotExist(err) {
			return "Lỗi: Không tìm thấy file ảnh gốc (đã kiểm tra .png và .jpg)."
		}
	}

	// 2. Tạo thư mục upscaled nếu chưa có
	upscaledDir := filepath.Join(outputDir, folderName, "images", "upscaled")
	if err := os.MkdirAll(upscaledDir, 0755); err != nil {
		return "Lỗi: Không thể tạo thư mục upscaled: " + err.Error()
	}

	// 3. Định nghĩa thư mục chứa tool (bin/realesrgan/)
	executable, _ := os.Executable()
	appDir := filepath.Dir(executable)
	binPath := filepath.Join(appDir, "bin", "realesrgan", "realesrgan-ncnn-vulkan.exe")
	if _, err := os.Stat(binPath); os.IsNotExist(err) {
		cwd, _ := os.Getwd()
		binPath = filepath.Join(cwd, "bin", "realesrgan", "realesrgan-ncnn-vulkan.exe")
	}
	if _, err := os.Stat(binPath); os.IsNotExist(err) {
		return "TOOL_NOT_FOUND"
	}

	// 4. Tạo đường dẫn file đầu ra (giữ nguyên tên gốc, để vào folder upscaled)
	fileName := filepath.Base(imagePath)
	outputPath := filepath.Join(upscaledDir, fileName)

	// 5. Thực thi lệnh (VRAM 200 cho ổn định)
	cmd := exec.Command(binPath, "-i", imagePath, "-o", outputPath, "-s", "4", "-n", "realesrgan-x4plus", "-t", "200")
	cmd.Dir = filepath.Dir(binPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	fmt.Printf("Starting upscale: %s -> %s\n", imagePath, outputPath)
	if err := cmd.Run(); err != nil {
		fmt.Printf("Upscale error: %v, Stderr: %s\n", err, stderr.String())
		return fmt.Sprintf("Lỗi thực thi (VRAM có thể bị đầy): %v. \nChi tiết: %s", err, stderr.String())
	}

	return "SUCCESS:" + outputPath
}

// UpscaleFolder performs 4x upscaling for all images in the specified folder
func (a *App) UpscaleFolder(outputDir string, folderName string) string {
	if outputDir == "" || folderName == "" {
		return "Lỗi: Thiếu tham số đường dẫn."
	}

	imagesDir := filepath.Join(outputDir, folderName, "images")
	entries, err := os.ReadDir(imagesDir)
	if err != nil {
		return "Lỗi đọc thư mục: " + err.Error()
	}

	// 1. Tạo thư mục upscaled nếu chưa có
	upscaledDir := filepath.Join(imagesDir, "upscaled")
	if err := os.MkdirAll(upscaledDir, 0755); err != nil {
		return "Lỗi: Không thể tạo thư mục upscaled: " + err.Error()
	}

	// 2. Tìm các file gốc hợp lệ
	var imageFiles []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext == ".png" || ext == ".jpg" {
			imageFiles = append(imageFiles, name)
		}
	}

	if len(imageFiles) == 0 {
		return "Lỗi: Không tìm thấy ảnh hợp lệ để upscale."
	}

	// 3. Kiểm tra tool
	executable, _ := os.Executable()
	appDir := filepath.Dir(executable)
	binPath := filepath.Join(appDir, "bin", "realesrgan", "realesrgan-ncnn-vulkan.exe")
	if _, err := os.Stat(binPath); os.IsNotExist(err) {
		cwd, _ := os.Getwd()
		binPath = filepath.Join(cwd, "bin", "realesrgan", "realesrgan-ncnn-vulkan.exe")
	}
	if _, err := os.Stat(binPath); os.IsNotExist(err) {
		return "TOOL_NOT_FOUND"
	}

	// 4. Xử lý từng file
	count := 0
	total := len(imageFiles)
	for i, name := range imageFiles {
		imagePath := filepath.Join(imagesDir, name)
		outputPath := filepath.Join(upscaledDir, name)

		runtime.EventsEmit(a.ctx, "upscale_progress", map[string]interface{}{
			"current": i + 1,
			"total":   total,
			"file":    name,
		})

		cmd := exec.Command(binPath, "-i", imagePath, "-o", outputPath, "-s", "4", "-n", "realesrgan-x4plus", "-t", "200")
		cmd.Dir = filepath.Dir(binPath)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		
		fmt.Printf("[%d/%d] Upscaling: %s\n", i+1, total, name)
		if err := cmd.Run(); err == nil {
			count++
		}
	}

	return fmt.Sprintf("SUCCESS: Đã hoàn thành xử lý %d/%d ảnh. \nẢnh mới nằm trong thư mục: images/upscaled", count, total)
}

// SelectDirectory opens a directory dialog and returns the selected path
func (a *App) SelectDirectory() string {
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("Recovered from panic in SelectDirectory: %v\n", r)
		}
	}()

	fmt.Println("Opening directory dialog...")
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Chọn thư mục",
	})
	if err != nil {
		fmt.Printf("Error selecting directory: %v\n", err)
		return ""
	}
	fmt.Printf("Selected path: %s\n", path)
	return path
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

// ─────────────────────────────────────────────────────────
// Grok Chrome Functions
// ─────────────────────────────────────────────────────────

// StartGrokChrome mở Chrome và navigate tới grok.com
func (a *App) StartGrokChrome() string {
	g := grok.GetInstance()
	if g.IsRunning() {
		return "Already running"
	}
	if err := g.Start(a.ctx); err != nil {
		return "Error: " + err.Error()
	}
	runtime.EventsEmit(a.ctx, "grok_chrome_status", "running")
	return "Started"
}

// StopGrokChrome đóng Chrome
func (a *App) StopGrokChrome() string {
	grok.GetInstance().Stop()
	runtime.EventsEmit(a.ctx, "grok_chrome_status", "stopped")
	return "Stopped"
}

// GetGrokChromeStatus trả về trạng thái Chrome hiện tại
func (a *App) GetGrokChromeStatus() string {
	if grok.GetInstance().IsRunning() {
		return "running"
	}
	return "stopped"
}

// GenerateGrokImages bắt đầu quá trình tạo ảnh bằng Grok Chrome
func (a *App) GenerateGrokImages(cfg GrokGenerateConfig) string {
	g := grok.GetInstance()
	if !g.IsRunning() {
		return "Error: Chrome chưa được khởi động. Vui lòng nhấn 'Bật Chrome' trước."
	}

	if cfg.Output == "" {
		return "Error: Thiếu thư mục output"
	}
	if len(cfg.Prompts) == 0 {
		return "Error: Không có prompt nào"
	}
	if cfg.Album == "" {
		cfg.Album = time.Now().UTC().Format("20060102_150405")
	}
	if cfg.Count <= 0 {
		cfg.Count = 2
	}
	if cfg.Ratio == "" {
		cfg.Ratio = "1:1"
	}

	grokCfg := &grok.GrokConfig{
		Prompts:  cfg.Prompts,
		Output:   cfg.Output,
		AlbumID:  cfg.Album,
		Download: cfg.Download,
		Suffix:   cfg.Suffix,
		Count:    cfg.Count,
	}

	go func() {
		startTime := time.Now().UTC()

		images, err := g.GenerateBatch(grokCfg, func(current, tot int, msg string, isError bool) {
			var pct float32
			if tot > 0 {
				pct = float32(current) * 100.0 / float32(tot)
			}
			runtime.EventsEmit(a.ctx, "generation_progress", bulkai.Status{
				Percentage: pct,
			})
			if isError {
				runtime.EventsEmit(a.ctx, "grok_log", map[string]interface{}{"msg": msg, "type": "error"})
			} else {
				runtime.EventsEmit(a.ctx, "grok_log", map[string]interface{}{"msg": msg, "type": "info"})
			}
		})

		if err != nil {
			runtime.EventsEmit(a.ctx, "generation_error", err.Error())
			return
		}

		log.Printf("Grok: Hoàn thành, tạo được %d ảnh", len(images))

		// ── Tạo data.json (giống flow Discord) ──────────────────────────────
		albumDir := filepath.Join(cfg.Output, cfg.Album)
		_ = os.MkdirAll(albumDir, 0755)

		// Chuyển GrokImage sang bulkai.Image và tìm các prompt đã hoàn thành
		var albumImages []*bulkai.Image
		finishedMap := make(map[int]bool)
		for _, img := range images {
			albumImages = append(albumImages, &bulkai.Image{
				URL:    img.URL,
				Prompt: img.Prompt,
				File:   img.File,
			})
			// Đánh dấu prompt index đã hoàn thành
			for idx, p := range cfg.Prompts {
				if p == img.Prompt {
					finishedMap[idx] = true
				}
			}
		}

		var finished []int
		for idx := range finishedMap {
			finished = append(finished, idx)
		}

		status := "finished"
		pct := float32(100)
		if len(finished) < len(cfg.Prompts) {
			status = "partially finished"
			if len(cfg.Prompts) > 0 {
				pct = float32(len(finished)) * 100.0 / float32(len(cfg.Prompts))
			}
		}

		album := &bulkai.Album{
			ID:         cfg.Album,
			CreatedAt:  startTime,
			UpdatedAt:  time.Now().UTC(),
			Status:     status,
			Percentage: pct,
			Images:     albumImages,
			Prompts:    cfg.Prompts,
			Finished:   finished,
		}

		if err := bulkai.SaveAlbum(albumDir, album, true, false); err != nil {
			log.Printf("Grok: Lỗi khi tạo data.json: %v", err)
		} else {
			log.Printf("Grok: Đã tạo data.json tại %s", albumDir)
		}

		runtime.EventsEmit(a.ctx, "generation_finished", cfg.Album)
	}()

	return "Started"
}

// CheckUpdate queries GitHub API for the latest release
func (a *App) CheckUpdate() UpdateInfo {
	updateURL := "https://api.github.com/repos/PhongMOA/BulkAIUpdate/releases/latest"

	var info UpdateInfo
	info.HasUpdate = false
	info.Version = CurrentVersion

	req, err := http.NewRequest("GET", updateURL, nil)
	if err != nil {
		return info
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return info
	}
	defer resp.Body.Close()

	var release struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadUrl string `json:"browser_download_url"`
		} `json:"assets"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&release); err == nil {
		// Basic version string comparison (assuming tag is like "v1.0.1")
		if release.TagName != "" && release.TagName != CurrentVersion {
			info.HasUpdate = true
			info.Version = release.TagName
			info.Changelog = release.Body
			for _, asset := range release.Assets {
				if strings.HasSuffix(asset.Name, ".exe") {
					info.URL = asset.BrowserDownloadUrl
					break
				}
			}
		}
	}
	return info
}

// ApplyUpdate downloads and applies the new executable
func (a *App) ApplyUpdate(downloadURL string) string {
	if downloadURL == "" {
		return "Error: Empty download URL"
	}
	resp, err := http.Get(downloadURL)
	if err != nil {
		return "Failed to download update: " + err.Error()
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("Error: Server returned status %d", resp.StatusCode)
	}

	err = selfupdate.Apply(resp.Body, selfupdate.Options{})
	if err != nil {
		return "Failed to apply update: " + err.Error()
	}

	return "Success"
}
