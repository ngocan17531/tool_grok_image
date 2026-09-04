package main

import (
	"BulkAI/pkg/bridge"
	"BulkAI/pkg/bulkai"
	"BulkAI/pkg/grok"
	imgPkg "BulkAI/pkg/img"
	"BulkAI/pkg/session"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
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
	ctx            context.Context
	bridge         *bridge.Bridge
	flowCancelFunc context.CancelFunc
}

// GrokGenerateConfig là config gửi từ frontend cho Grok generation
type GrokGenerateConfig struct {
	Prompts    []string `json:"prompts"`
	Ratio      string   `json:"ratio"`
	Count      int      `json:"count"`
	Output     string   `json:"output"`
	Album      string   `json:"album"`
	Download   bool     `json:"download"`
	Suffix     string   `json:"suffix"`
	UseImagine bool     `json:"useImagine"`
}

// GoogleFlowGenerateConfig là config gửi từ frontend cho Google Flow generation
type GoogleFlowGenerateConfig struct {
	Prompts  []string `json:"prompts"`
	Output   string   `json:"output"`
	Album    string   `json:"album"`
	Download bool     `json:"download"`
	FlowURL  string   `json:"flowUrl"`
	Delay    int      `json:"delay"` // Thời gian chờ (giây) sau khi nhận ảnh, trước prompt tiếp theo
}

// CurrentVersion is the current version of the application
const CurrentVersion = "v1.0.4"

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

func readAlbumData(outputDir string, albumID string) (bulkai.Album, error) {
	var album bulkai.Album
	albumPath := filepath.Join(outputDir, albumID)
	dataPath := filepath.Join(albumPath, "data.json")

	data, err := os.ReadFile(dataPath)
	if err == nil {
		if err := json.Unmarshal(data, &album); err != nil {
			return album, fmt.Errorf("couldn't parse data.json: %w", err)
		}
		return album, nil
	}
	if !os.IsNotExist(err) {
		return album, err
	}

	imagesPath := filepath.Join(albumPath, "images")
	entries, err := os.ReadDir(imagesPath)
	if err != nil {
		return album, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !isAlbumImageFile(entry.Name()) {
			continue
		}
		album.Images = append(album.Images, &bulkai.Image{File: entry.Name()})
	}
	sort.Slice(album.Images, func(i, j int) bool {
		return album.Images[i].File < album.Images[j].File
	})

	album.ID = albumID
	album.Status = "finished"
	data, err = json.MarshalIndent(album, "", "  ")
	if err != nil {
		return album, fmt.Errorf("couldn't create data.json: %w", err)
	}
	if err := os.WriteFile(dataPath, data, 0644); err != nil {
		return album, fmt.Errorf("couldn't write data.json: %w", err)
	}
	return album, nil
}

func isAlbumImageFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return true
	default:
		return false
	}
}

// GetAlbumData reads data.json, creating image-only metadata when it is missing.
func (a *App) GetAlbumData(outputDir string, albumID string) string {
	if albumID == "" || outputDir == "" {
		return ""
	}
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return ""
	}
	data, err := json.MarshalIndent(album, "", "  ")
	if err != nil {
		return ""
	}
	return string(data)
}

// FixAlbumData creates data.json from the image files when album metadata is missing.
func (a *App) FixAlbumData(outputDir string, albumID string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}
	if _, err := readAlbumData(outputDir, albumID); err != nil {
		return "Error fixing data.json: " + err.Error()
	}
	return "Success: data.json đã được tạo/cập nhật cho album " + albumID
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

// GalleryImageInfo represents a thumbnail file name without base64 data (lightweight)
type GalleryImageInfo struct {
	Name string `json:"name"`
}

// GalleryPageResult contains paginated gallery results
type GalleryPageResult struct {
	Images     []GalleryImage `json:"images"`
	Total      int            `json:"total"`
	Page       int            `json:"page"`
	PageSize   int            `json:"pageSize"`
	TotalPages int            `json:"totalPages"`
}

// GetGalleryImageList returns only the file names of all thumbnails (no base64 data)
// This is very fast as it only reads the directory listing.
func (a *App) GetGalleryImageList(outputDir string, folderName string) []GalleryImageInfo {
	var images []GalleryImageInfo
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
			images = append(images, GalleryImageInfo{Name: entry.Name()})
		}
	}
	return images
}

// GetGalleryImages returns base64 encoded thumbnails for a given folder (paginated)
// page starts from 1, pageSize is number of images per page (default 30)
func (a *App) GetGalleryImages(outputDir string, folderName string, page int, pageSize int) GalleryPageResult {
	result := GalleryPageResult{Page: page, PageSize: pageSize}
	if outputDir == "" || folderName == "" {
		return result
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 30
	}

	thumbDir := filepath.Join(outputDir, folderName, "images", "_thumbnails")
	entries, err := os.ReadDir(thumbDir)
	if err != nil {
		return result
	}

	// Filter to only image files
	var imageEntries []os.DirEntry
	for _, entry := range entries {
		if !entry.IsDir() && (filepath.Ext(entry.Name()) == ".jpg" || filepath.Ext(entry.Name()) == ".png") {
			imageEntries = append(imageEntries, entry)
		}
	}

	result.Total = len(imageEntries)
	result.TotalPages = (result.Total + pageSize - 1) / pageSize
	result.Page = page
	result.PageSize = pageSize

	// Calculate slice bounds
	start := (page - 1) * pageSize
	if start >= len(imageEntries) {
		return result
	}
	end := start + pageSize
	if end > len(imageEntries) {
		end = len(imageEntries)
	}

	// Only read the files in the current page
	for _, entry := range imageEntries[start:end] {
		imgPath := filepath.Join(thumbDir, entry.Name())
		data, err := os.ReadFile(imgPath)
		if err == nil {
			b64 := base64.StdEncoding.EncodeToString(data)
			result.Images = append(result.Images, GalleryImage{
				Name:   entry.Name(),
				Base64: "data:image/jpeg;base64," + b64,
			})
		}
	}
	return result
}

// GetThumbnailBase64 returns base64 for a single thumbnail by name
func (a *App) GetThumbnailBase64(outputDir string, folderName string, thumbName string) string {
	if outputDir == "" || folderName == "" || thumbName == "" {
		return ""
	}
	imgPath := filepath.Join(outputDir, folderName, "images", "_thumbnails", thumbName)
	data, err := os.ReadFile(imgPath)
	if err != nil {
		return ""
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
}

// GetImageFullBase64 returns base64 encoded full size image
func (a *App) GetImageFullBase64(outputDir string, folderName string, thumbName string) string {
	if outputDir == "" || folderName == "" || thumbName == "" {
		return ""
	}

	// Remove .jpg from thumbnail name to find original base name
	base := strings.TrimSuffix(thumbName, filepath.Ext(thumbName))

	// Try possible original files in images folder
	fullPath := filepath.Join(outputDir, folderName, "images", base+".png")
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		fullPath = filepath.Join(outputDir, folderName, "images", base+".jpg")
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
		filepath.Join(outputDir, folderName, "images", base+".png"),
		filepath.Join(outputDir, folderName, "images", base+".jpg"),
	}

	// Delete thumbnail
	_ = os.Remove(thumbPath)

	// Delete full images
	for _, p := range fullPaths {
		_ = os.Remove(p)
	}

	return "Success"
}

// subjectRegex matches [Subject: ...] pattern in prompts
var subjectRegex = regexp.MustCompile(`(?i)\[Subject:\s*([^\]]+)\]`)

// extractTitle extracts a clean title from a prompt string.
// It strips the prefix, extracts content from [Subject: ...] if present,
// falls back to first sentence, and always removes "Subject" prefix from result.
func extractTitle(prompt string, prefix string) string {
	title := prompt
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

	// Always strip "Subject:" or "Subject" prefix (case-insensitive)
	lower := strings.ToLower(title)
	if strings.HasPrefix(lower, "subject:") {
		title = strings.TrimSpace(title[len("subject:"):])
	} else if strings.HasPrefix(lower, "subject ") {
		title = strings.TrimSpace(title[len("subject "):])
	}

	return title
}

// ExportGalleryReport generates an Excel file for the given album
func (a *App) ExportGalleryReport(outputDir string, albumID string, prefix string, geminiKey string) string {
	if albumID == "" || outputDir == "" || geminiKey == "" {
		return "Error: Missing parameters or Gemini API key"
	}

	albumPath := filepath.Join(outputDir, albumID)
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return "Error reading data.json: " + err.Error()
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

		// 2. Title — lấy phần Subject từ prompt
		title := extractTitle(img.Prompt, prefix)
		if len([]rune(title)) > 200 {
			title = string([]rune(title)[:200])
		}
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

// ExportCSV xuất dữ liệu album ra file CSV
func (a *App) ExportCSV(outputDir string, albumID string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}

	albumPath := filepath.Join(outputDir, albumID)
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return "Error reading data.json: " + err.Error()
	}

	csvPath := filepath.Join(albumPath, fmt.Sprintf("report_%s.csv", albumID))
	file, err := os.Create(csvPath)
	if err != nil {
		return "Error creating CSV: " + err.Error()
	}
	defer file.Close()

	// BOM for Excel UTF-8
	file.Write([]byte{0xEF, 0xBB, 0xBF})

	writer := csv.NewWriter(file)
	defer writer.Flush()

	// Header
	writer.Write([]string{"Filename", "Prompt", "URL"})

	for _, img := range album.Images {
		if img.File == "" {
			continue
		}
		imgPath := filepath.Join(albumPath, "images", img.File)
		if _, err := os.Stat(imgPath); os.IsNotExist(err) {
			continue
		}
		writer.Write([]string{img.File, img.Prompt, img.URL})
	}

	return "Success: " + csvPath
}

// AlbumTitleInfo chứa thông tin title từ album để frontend dùng tạo keywords
type AlbumTitleInfo struct {
	Title string `json:"title"`
	Count int    `json:"count"` // Số ảnh có cùng title
}

// GetAlbumTitles trả về danh sách các title duy nhất từ album để frontend tạo keywords
func (a *App) GetAlbumTitles(outputDir string, albumID string, prefix string) []AlbumTitleInfo {
	var titles []AlbumTitleInfo
	if albumID == "" || outputDir == "" {
		return titles
	}

	albumPath := filepath.Join(outputDir, albumID)
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return titles
	}

	titleCount := make(map[string]int)
	titleOrder := []string{}

	for _, img := range album.Images {
		if img.File == "" {
			continue
		}
		imgPath := filepath.Join(albumPath, "images", img.File)
		if _, err := os.Stat(imgPath); os.IsNotExist(err) {
			continue
		}

		title := extractTitle(img.Prompt, prefix)

		if title == "" {
			continue
		}

		if _, exists := titleCount[title]; !exists {
			titleOrder = append(titleOrder, title)
		}
		titleCount[title]++
	}

	for _, t := range titleOrder {
		titles = append(titles, AlbumTitleInfo{Title: t, Count: titleCount[t]})
	}

	return titles
}

// ExportGalleryReportWithKeywords xuất báo cáo Excel với keywords đã được tạo sẵn từ frontend
func (a *App) ExportGalleryReportWithKeywords(outputDir string, albumID string, prefix string, keywordsMap map[string]string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}

	albumPath := filepath.Join(outputDir, albumID)
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return "Error reading data.json: " + err.Error()
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

	for _, img := range album.Images {
		if img.File == "" {
			continue
		}

		imgPath := filepath.Join(albumPath, "images", img.File)
		if _, err := os.Stat(imgPath); os.IsNotExist(err) {
			continue
		}

		// 1. Filename
		f.SetCellValue(sheetName, fmt.Sprintf("A%d", row), img.File)

		// 2. Title — lấy phần Subject từ prompt
		fullTitle := extractTitle(img.Prompt, prefix)
		title := fullTitle
		if len([]rune(title)) > 200 {
			title = string([]rune(title)[:200])
		}
		f.SetCellValue(sheetName, fmt.Sprintf("B%d", row), title)

		// 3. Keywords from pre-generated map — lookup bằng fullTitle (chưa truncate) để khớp key từ GetAlbumTitles
		keywords := ""
		if fullTitle != "" {
			if kw, ok := keywordsMap[fullTitle]; ok {
				keywords = kw
			} else if kw, ok := keywordsMap[title]; ok {
				// fallback: thử với title đã truncate
				keywords = kw
			}
		}
		f.SetCellValue(sheetName, fmt.Sprintf("C%d", row), keywords)

		// 4 & 5. Category & Releases - Empty
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

// FixExcelTitles đọc file report xlsx của album, làm sạch lại cột Title (B) bằng extractTitle,
// rồi ghi đè lại file. Trả về "Success: <path>" hoặc "Error: <msg>".
func (a *App) FixExcelTitles(outputDir string, albumID string, prefix string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}

	albumPath := filepath.Join(outputDir, albumID)
	excelPath := filepath.Join(albumPath, fmt.Sprintf("report_%s.xlsx", albumID))

	f, err := excelize.OpenFile(excelPath)
	if err != nil {
		return "Error opening Excel file: " + err.Error()
	}
	defer f.Close()

	sheetName := f.GetSheetName(0)
	if sheetName == "" {
		return "Error: No sheets found in Excel file"
	}

	rows, err := f.GetRows(sheetName)
	if err != nil {
		return "Error reading rows: " + err.Error()
	}

	fixed := 0
	// Row 0 = header, start from row index 1 (Excel row 2)
	for i := 1; i < len(rows); i++ {
		row := rows[i]
		if len(row) < 2 {
			continue
		}
		rawTitle := row[1] // Column B = index 1
		if rawTitle == "" {
			continue
		}

		cleanTitle := extractTitle(rawTitle, prefix)
		// Truncate to 200 runes if needed
		if len([]rune(cleanTitle)) > 200 {
			cleanTitle = string([]rune(cleanTitle)[:200])
		}

		if cleanTitle != rawTitle {
			cell, _ := excelize.CoordinatesToCellName(2, i+1) // col 2 = B, row i+1
			f.SetCellValue(sheetName, cell, cleanTitle)
			fixed++
		}
	}

	if err := f.Save(); err != nil {
		return "Error saving Excel: " + err.Error()
	}

	return fmt.Sprintf("Success: %s (fixed %d titles)", excelPath, fixed)
}

// ExportCSVWithKeywords xuất CSV với cột Keywords đã được tạo sẵn
func (a *App) ExportCSVWithKeywords(outputDir string, albumID string, prefix string, keywordsMap map[string]string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}

	albumPath := filepath.Join(outputDir, albumID)
	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		return "Error reading data.json: " + err.Error()
	}

	csvPath := filepath.Join(albumPath, fmt.Sprintf("report_%s.csv", albumID))
	file, err := os.Create(csvPath)
	if err != nil {
		return "Error creating CSV: " + err.Error()
	}
	defer file.Close()

	// BOM for Excel UTF-8
	file.Write([]byte{0xEF, 0xBB, 0xBF})

	writer := csv.NewWriter(file)
	defer writer.Flush()

	// Header
	writer.Write([]string{"Filename", "Prompt", "Keywords", "URL"})

	for _, img := range album.Images {
		if img.File == "" {
			continue
		}
		imgPath := filepath.Join(albumPath, "images", img.File)
		if _, err := os.Stat(imgPath); os.IsNotExist(err) {
			continue
		}

		// Title — lấy phần Subject từ prompt
		title := extractTitle(img.Prompt, prefix)

		keywords := ""
		if kw, ok := keywordsMap[title]; ok {
			keywords = kw
		}

		writer.Write([]string{img.File, img.Prompt, keywords, img.URL})
	}

	return "Success: " + csvPath
}

// DeleteAlbum xóa toàn bộ album (thư mục + dữ liệu)
func (a *App) DeleteAlbum(outputDir string, albumID string) string {
	if albumID == "" || outputDir == "" {
		return "Error: Missing parameters"
	}

	albumPath := filepath.Join(outputDir, albumID)
	if _, err := os.Stat(albumPath); os.IsNotExist(err) {
		return "Error: Album not found"
	}

	if err := os.RemoveAll(albumPath); err != nil {
		return "Error deleting album: " + err.Error()
	}

	return "Success: Đã xóa album " + albumID
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
// Bridge Functions (ChatGPT Extension WebSocket)
// ─────────────────────────────────────────────────────────

// StartBridge khởi động WebSocket server cho extension
func (a *App) StartBridge() string {
	if a.bridge != nil && a.bridge.IsRunning() {
		return "already_running"
	}

	a.bridge = bridge.New()

	// Callback khi status thay đổi → emit event tới frontend
	a.bridge.SetOnStatusChange(func(running bool, connected bool) {
		runtime.EventsEmit(a.ctx, "bridge_status", map[string]interface{}{
			"running":   running,
			"connected": connected,
		})
	})

	// Callback khi nhận response từ ChatGPT
	a.bridge.SetOnResponse(func(id string, content string, status string) {
		runtime.EventsEmit(a.ctx, "bridge_response", map[string]interface{}{
			"id":      id,
			"content": content,
			"status":  status,
		})
	})

	if err := a.bridge.Start(); err != nil {
		return "error: " + err.Error()
	}

	a.bridge.StartHeartbeat()
	return "ok"
}

// StopBridge dừng WebSocket server
func (a *App) StopBridge() string {
	if a.bridge != nil {
		a.bridge.Stop()
		a.bridge = nil
	}
	return "ok"
}

// GetBridgeStatus trả về trạng thái hiện tại của Bridge
func (a *App) GetBridgeStatus() map[string]interface{} {
	if a.bridge == nil {
		return map[string]interface{}{
			"running":   false,
			"connected": false,
		}
	}
	return map[string]interface{}{
		"running":   a.bridge.IsRunning(),
		"connected": a.bridge.IsExtensionConnected(),
	}
}

// SendBridgePrompt gửi prompt tới extension qua Bridge
func (a *App) SendBridgePrompt(id string, content string) string {
	if a.bridge == nil || !a.bridge.IsRunning() {
		return "error: bridge chưa chạy"
	}
	if !a.bridge.IsExtensionConnected() {
		return "error: extension chưa kết nối"
	}
	if err := a.bridge.SendPrompt(id, content); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
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
		Prompts:    cfg.Prompts,
		Output:     cfg.Output,
		AlbumID:    cfg.Album,
		Download:   cfg.Download,
		Suffix:     cfg.Suffix,
		Count:      cfg.Count,
		UseImagine: cfg.UseImagine,
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

// ─────────────────────────────────────────────────────────────────────────────
// Google Flow Chrome Integration
// ─────────────────────────────────────────────────────────────────────────────

// StartGoogleFlowChrome mở Chrome và navigate tới Google Flow
func (a *App) StartGoogleFlowChrome(flowURL string) string {
	// Google Flow giờ dùng Bridge WebSocket + Chrome Extension
	// Không cần mở Chrome riêng nữa — dùng Chrome thường của user
	if a.bridge == nil {
		a.bridge = bridge.New()
		a.bridge.SetOnStatusChange(func(running bool, connected bool) {
			runtime.EventsEmit(a.ctx, "bridge_status", map[string]interface{}{
				"running":   running,
				"connected": connected,
			})
			// Cập nhật Google Flow status dựa trên bridge
			if connected {
				runtime.EventsEmit(a.ctx, "gflow_chrome_status", "running")
			} else if running {
				runtime.EventsEmit(a.ctx, "gflow_chrome_status", "waiting")
			} else {
				runtime.EventsEmit(a.ctx, "gflow_chrome_status", "stopped")
			}
		})
		a.bridge.SetOnResponse(func(id string, content string, status string) {
			runtime.EventsEmit(a.ctx, "bridge_response", map[string]interface{}{
				"id":      id,
				"content": content,
				"status":  status,
			})
		})
		a.bridge.SetOnFlowProgress(func(id string, status string, message string) {
			runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
				"msg":  fmt.Sprintf("[%s] %s", status, message),
				"type": "info",
			})
		})
	}

	if a.bridge.IsRunning() {
		if a.bridge.IsExtensionConnected() {
			return "Already running"
		}
		return "Started"
	}

	if err := a.bridge.Start(); err != nil {
		return "Error: " + err.Error()
	}
	a.bridge.StartHeartbeat()

	runtime.EventsEmit(a.ctx, "gflow_chrome_status", "waiting")
	log.Println("GoogleFlow: Bridge WebSocket server đã chạy trên port 8765. Chờ Chrome Extension kết nối...")
	return "Started"
}

// StopGoogleFlowChrome đóng Bridge
func (a *App) StopGoogleFlowChrome() string {
	if a.bridge != nil {
		a.bridge.Stop()
	}
	runtime.EventsEmit(a.ctx, "gflow_chrome_status", "stopped")
	return "Stopped"
}

// GetGoogleFlowChromeStatus trả về trạng thái
func (a *App) GetGoogleFlowChromeStatus() string {
	if a.bridge != nil && a.bridge.IsRunning() {
		if a.bridge.IsExtensionConnected() {
			return "running"
		}
		return "waiting"
	}
	return "stopped"
}

// GenerateGoogleFlowImages tạo ảnh qua Bridge → Chrome Extension
func (a *App) GenerateGoogleFlowImages(cfg GoogleFlowGenerateConfig) string {
	if a.bridge == nil || !a.bridge.IsRunning() {
		return "Error: Bridge chưa chạy. Vui lòng nhấn 'Bật Bridge' trước."
	}
	if !a.bridge.IsExtensionConnected() {
		return "Error: Chrome Extension chưa kết nối. Vui lòng cài extension và mở labs.google."
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

	flowURL := cfg.FlowURL
	if flowURL == "" {
		flowURL = "https://labs.google/fx/tools/flow"
	}

	// Cancel context cho Stop
	flowCtx, cancelFunc := context.WithCancel(context.Background())
	a.flowCancelFunc = cancelFunc

	go func() {
		defer func() {
			a.flowCancelFunc = nil
		}()

		startTime := time.Now().UTC()
		total := len(cfg.Prompts)
		albumDir := filepath.Join(cfg.Output, cfg.Album)
		imgDir := filepath.Join(albumDir, "images")
		thumbDir := filepath.Join(imgDir, "_thumbnails")
		if cfg.Download {
			_ = os.MkdirAll(imgDir, 0755)
			_ = os.MkdirAll(thumbDir, 0755)
		}

		var albumImages []*bulkai.Image
		finishedMap := make(map[int]bool)
		stopped := false

		// Helper: save data.json (gọi sau mỗi prompt)
		saveDataJSON := func(status string) {
			_ = os.MkdirAll(albumDir, 0755)
			var finished []int
			for idx := range finishedMap {
				finished = append(finished, idx)
			}
			pct := float32(100)
			if len(finished) < len(cfg.Prompts) {
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
				log.Printf("GoogleFlow: Lỗi khi tạo data.json: %v", err)
			}
		}

		for i, prompt := range cfg.Prompts {
			// Check cancel
			select {
			case <-flowCtx.Done():
				log.Printf("GoogleFlow: Đã dừng bởi user tại prompt %d", i)
				runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
					"msg":  "⏹️ Đã dừng bởi người dùng",
					"type": "warning",
				})
				stopped = true
				goto done
			default:
			}

			promptID := fmt.Sprintf("flow_%d_%d", time.Now().UnixMilli(), i)

			runtime.EventsEmit(a.ctx, "generation_progress", bulkai.Status{
				Percentage: float32(i) * 100.0 / float32(total),
			})
			runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
				"msg":  fmt.Sprintf("[%d/%d] ⌨️ Gửi prompt: %s", i+1, total, prompt[:min(len(prompt), 60)]),
				"type": "info",
			})

			// Gửi prompt qua Bridge
			if err := a.bridge.SendFlowPrompt(promptID, prompt, flowURL); err != nil {
				log.Printf("GoogleFlow: Lỗi gửi prompt %d: %v", i, err)
				runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
					"msg":  fmt.Sprintf("[%d/%d] ❌ Lỗi gửi: %v", i+1, total, err),
					"type": "error",
				})
				continue
			}

			// Chờ kết quả (5 phút timeout mỗi prompt)
			result, err := a.bridge.WaitForFlowResultWithContext(flowCtx, 5*time.Minute)
			if err != nil {
				log.Printf("GoogleFlow: Lỗi prompt %d: %v", i, err)
				runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
					"msg":  fmt.Sprintf("[%d/%d] ❌ Lỗi: %v", i+1, total, err),
					"type": "error",
				})
				continue
			}

			// Lưu ảnh
			for j, img := range result.Images {
				fileName := fmt.Sprintf("gflow_%s_%05d_%02d.png",
					sanitizeFilename(prompt, 30), i, j)

				albumImg := &bulkai.Image{
					URL:    img.URL,
					Prompt: prompt,
					File:   fileName,
				}

				if cfg.Download {
					var data []byte
					var err error
					if img.Base64 != "" {
						data, err = base64.StdEncoding.DecodeString(img.Base64)
					} else if img.URL != "" && strings.HasPrefix(img.URL, "http") {
						resp, httpErr := http.Get(img.URL)
						if httpErr == nil && resp.StatusCode == http.StatusOK {
							defer resp.Body.Close()
							data, err = io.ReadAll(resp.Body)
						}
					}

					if err == nil && len(data) > 0 {
						savePath := filepath.Join(imgDir, fileName)
						if err := os.WriteFile(savePath, data, 0644); err != nil {
							log.Printf("GoogleFlow: Lỗi lưu ảnh: %v", err)
						} else {
							log.Printf("GoogleFlow: 💾 Đã lưu: %s (%d KB)", fileName, len(data)/1024)

							// Tạo thumbnail trong _thumbnails
							thumbName := strings.TrimSuffix(fileName, filepath.Ext(fileName)) + ".jpg"
							thumbPath := filepath.Join(thumbDir, thumbName)
							if err := imgPkg.Resize(4, savePath, thumbPath); err != nil {
								log.Printf("GoogleFlow: Lỗi tạo thumbnail (%v), ghi trực tiếp...", err)
								_ = os.WriteFile(thumbPath, data, 0644)
							} else {
								log.Printf("GoogleFlow: 🖼️ Đã tạo thumbnail: %s", thumbName)
							}
						}
					}
				}

				albumImages = append(albumImages, albumImg)
			}

			finishedMap[i] = true
			runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
				"msg":  fmt.Sprintf("[%d/%d] ✅ Xong — %d ảnh", i+1, total, len(result.Images)),
				"type": "info",
			})

			// Save data.json sau mỗi prompt (realtime)
			saveDataJSON("running")

			// Chờ giữa các prompt
			if i < total-1 {
				delaySec := cfg.Delay
				if delaySec <= 0 {
					delaySec = 3
				}
				runtime.EventsEmit(a.ctx, "gflow_log", map[string]interface{}{
					"msg":  fmt.Sprintf("⏳ Chờ %d giây trước prompt tiếp theo...", delaySec),
					"type": "info",
				})
				select {
				case <-flowCtx.Done():
					stopped = true
					goto done
				case <-time.After(time.Duration(delaySec) * time.Second):
				}
			}
		}

	done:
		log.Printf("GoogleFlow: Hoàn thành, tạo được %d ảnh", len(albumImages))

		// Final data.json
		finalStatus := "finished"
		if stopped {
			finalStatus = "stopped"
		} else if len(finishedMap) < len(cfg.Prompts) {
			finalStatus = "partially finished"
		}
		saveDataJSON(finalStatus)
		log.Printf("GoogleFlow: Đã tạo data.json tại %s", albumDir)

		runtime.EventsEmit(a.ctx, "generation_finished", cfg.Album)
	}()

	return "Started"
}

// StopGoogleFlowGeneration dừng quá trình tạo ảnh Google Flow
func (a *App) StopGoogleFlowGeneration() string {
	if a.flowCancelFunc != nil {
		a.flowCancelFunc()
		log.Println("GoogleFlow: Đã gửi tín hiệu dừng")
		return "Stopped"
	}
	return "Not running"
}

// sanitizeFilename tạo tên file an toàn từ prompt
func sanitizeFilename(s string, maxLen int) string {
	// Chỉ giữ alphanumeric và underscore
	result := make([]byte, 0, maxLen)
	for _, c := range []byte(strings.ToLower(s)) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			result = append(result, c)
		} else if c == ' ' || c == '-' || c == '_' {
			result = append(result, '_')
		}
		if len(result) >= maxLen {
			break
		}
	}
	return string(result)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// CheckUpdate queries GitHub API for the latest release
func (a *App) CheckUpdate() UpdateInfo {
	//updateURL := "https://api.github.com/repos/PhongMOA/BulkAIUpdate/releases/latest"
	updateURL := "https://api.github.com/repos/ngocan17531/tool_grok_image/releases/latest"

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

// ============================================================
// Watermark Removal (GeminiWatermarkTool integration)
// ============================================================

// WatermarkOptions la config gui tu frontend
type WatermarkOptions struct {
	Profile   string  `json:"profile"`   // "auto" | "v2" | "legacy"
	Threshold float64 `json:"threshold"` // 0.0 - 1.0
	Force     bool    `json:"force"`     // --force
	Overwrite bool    `json:"overwrite"` // true = ghi de file goc
}

// wmCancelFunc luu cancel func cua lan chay watermark hien tai
var wmCancelFunc context.CancelFunc

// getGWTToolPath tim GeminiWatermarkTool.exe o nhieu vi tri (ho tro ca dev mode)
func getGWTToolPath() (string, bool) {
	const toolName = "GeminiWatermarkTool.exe"
	// 1. Cung thu muc voi exe (production)
	if exePath, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exePath), toolName)
		if _, err := os.Stat(p); err == nil {
			return p, true
		}
	}
	// 2. Thu muc lam viec hien tai (dev mode: wails dev)
	if cwd, err := os.Getwd(); err == nil {
		p := filepath.Join(cwd, toolName)
		if _, err := os.Stat(p); err == nil {
			return p, true
		}
	}
	return "", false
}

// CheckGWTTool kiem tra GeminiWatermarkTool.exe co ton tai khong
func (a *App) CheckGWTTool() bool {
	_, found := getGWTToolPath()
	return found
}

// RemoveWatermarkBatch chay GeminiWatermarkTool hang loat tren inputDir
func (a *App) RemoveWatermarkBatch(inputDir string, outputDir string, opts WatermarkOptions) string {
	if inputDir == "" {
		return "Error: Chua chon thu muc anh"
	}
	toolPath, found := getGWTToolPath()
	if !found {
		return "Error: Khong tim thay GeminiWatermarkTool.exe - vui long dat file nay cung thu muc voi BulkAI_Custom.exe"
	}
	outDir := outputDir
	if opts.Overwrite || outDir == "" {
		outDir = inputDir
	}
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return "Error: Khong the tao thu muc output: " + err.Error()
	}
	args := []string{"-i", inputDir, "-o", outDir, "--no-banner"}
	args = append(args, fmt.Sprintf("--threshold=%.2f", opts.Threshold))
	switch opts.Profile {
	case "legacy":
		args = append(args, "--legacy")
	case "v2":
		args = append(args, "--no-legacy")
	}
	if opts.Force {
		args = append(args, "--force")
	}
	ctx, cancel := context.WithCancel(context.Background())
	wmCancelFunc = cancel
	cmd := exec.CommandContext(ctx, toolPath, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		cancel()
		return "Error: Khong the khoi chay tool: " + err.Error()
	}
	streamLines := func(reader io.Reader, prefix string) {
		buf := make([]byte, 4096)
		var partial string
		for {
			n, readErr := reader.Read(buf)
			if n > 0 {
				partial += string(buf[:n])
				for {
					idx := strings.IndexAny(partial, "\n\r")
					if idx < 0 {
						break
					}
					line := strings.TrimRight(partial[:idx], "\r")
					partial = partial[idx+1:]
					if strings.TrimSpace(line) != "" {
						runtime.EventsEmit(a.ctx, "watermark:log", prefix+line)
					}
				}
			}
			if readErr != nil {
				break
			}
		}
		if strings.TrimSpace(partial) != "" {
			runtime.EventsEmit(a.ctx, "watermark:log", prefix+partial)
		}
	}
	go streamLines(stdout, "")
	go streamLines(stderr, "[stderr] ")
	cmdErr := cmd.Wait()
	cancel()
	if ctx.Err() == context.Canceled {
		runtime.EventsEmit(a.ctx, "watermark:done", "Da dung boi nguoi dung")
		return "Stopped"
	}
	if cmdErr != nil {
		msg := "Loi khi chay tool: " + cmdErr.Error()
		runtime.EventsEmit(a.ctx, "watermark:done", msg)
		return "Error: " + msg
	}
	doneMsg := fmt.Sprintf("Hoan thanh! Output: %s", outDir)
	runtime.EventsEmit(a.ctx, "watermark:done", doneMsg)
	return "Success: " + outDir
}

// StopWatermarkBatch dung tien trinh remove watermark dang chay
func (a *App) StopWatermarkBatch() {
	if wmCancelFunc != nil {
		wmCancelFunc()
	}
}
