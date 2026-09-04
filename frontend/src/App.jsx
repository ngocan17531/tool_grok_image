import { useState, useEffect, useRef } from 'react';
import { GenerateImages, FetchSession, CheckSession, Logout, GetAlbumData, GetGalleryFolders, GetGalleryImages, GetGalleryImageList, GetImageFullBase64, DeleteImage, ExportGalleryReport, ExportCSV, DeleteAlbum, SelectDirectory, UpscaleImage, UpscaleFolder, CheckUpdate, ApplyUpdate, StartGrokChrome, StopGrokChrome, GetGrokChromeStatus, GenerateGrokImages, StartGoogleFlowChrome, StopGoogleFlowChrome, GetGoogleFlowChromeStatus, GenerateGoogleFlowImages, StopGoogleFlowGeneration, StartBridge, StopBridge, GetBridgeStatus, SendBridgePrompt, GetAlbumTitles, ExportGalleryReportWithKeywords, ExportCSVWithKeywords, FixExcelTitles, FixAlbumData } from "../wailsjs/go/main/App";
import { EventsOn, EventsOff, BrowserOpenURL } from "../wailsjs/runtime/runtime";
import { LayoutDashboard, Settings, Image as ImageIcon, Zap, Terminal, ChevronRight, ChevronLeft, ChevronDown, CheckCircle2, Play, UserCircle, Trash2, FolderPlus, CheckSquare, Square, X, ExternalLink, Copy, FileSpreadsheet, Folder, Sparkles, Maximize, Download, FileText, MousePointerClick } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import './App.css';
import logo from './assets/logo.svg';

function App() {
    const [activeTab, setActiveTab] = useState('generator');
    const [config, setConfig] = useState(() => {
        const saved = localStorage.getItem('bulkai_config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) { }
        }
        return {
            bot: 'midjourney',
            channel: '',
            prompts: [],
            prefix: '',
            suffix: ' --ar 3:2',
            upscale: true,
            download: true,
            thumbnail: true,
            output: './output',
            concurrency: 3,
            openaiKey: '',
            geminiKey: '',
            supabaseUrl: '',
            supabaseKey: '',
            // Grok-specific
            grokRatio: '1:1',
            grokCount: 2,
            grokSuffix: '',
            // Google Flow
            googleFlowUrl: 'https://flow.google.com/project',
            googleFlowDelay: 10
        };
    });
    const [promptText, setPromptText] = useState(() => localStorage.getItem('bulkai_prompts') || '');

    // Banned words: [{banned: string, replacement: string}]
    const [bannedWords, setBannedWords] = useState(() => {
        const saved = localStorage.getItem('bulkai_banned_words');
        if (saved) { try { return JSON.parse(saved); } catch(e) {} }
        return [];
    });
    useEffect(() => {
        localStorage.setItem('bulkai_banned_words', JSON.stringify(bannedWords));
    }, [bannedWords]);

    // Replace banned words in a prompt string
    const replaceBannedWords = (text) => {
        if (!bannedWords || bannedWords.length === 0) return text;
        let result = text;
        for (const entry of bannedWords) {
            if (entry.banned && entry.banned.trim()) {
                const regex = new RegExp(entry.banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                result = result.replace(regex, entry.replacement || '');
            }
        }
        return result;
    };
    const [status, setStatus] = useState({ percentage: 0, estimated: '0m' });
    const [isGenerating, setIsGenerating] = useState(false);
    const [logs, setLogs] = useState([]);

    const [sessionStatus, setSessionStatus] = useState('Đang kiểm tra...');
    const [sessionUser, setSessionUser] = useState(null);
    const [isFetchingSession, setIsFetchingSession] = useState(false);

    // Grok Chrome states
    const [grokChromeStatus, setGrokChromeStatus] = useState('stopped');
    const [isTogglingChrome, setIsTogglingChrome] = useState(false);

    // Google Flow Chrome states
    const [googleFlowChromeStatus, setGoogleFlowChromeStatus] = useState('stopped');
    const [isTogglingGFlowChrome, setIsTogglingGFlowChrome] = useState(false);

    // Auto Update states
    const [updateInfo, setUpdateInfo] = useState(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [isUpdating, setIsUpdating] = useState(false);

    // Prompt Generation States
    const [promptIdea, setPromptIdea] = useState("");
    const [promptCount, setPromptCount] = useState(5);
    const [promptPlatform, setPromptPlatform] = useState('gpt-4o');
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
    const [generatedPrompts, setGeneratedPrompts] = useState([]);
    const [selectedIdeaIds, setSelectedIdeaIds] = useState([]); // Stores indices for current session results
    const [categories, setCategories] = useState([]);
    const [selectedCategoryId, setSelectedCategoryId] = useState("");
    const [categorySearch, setCategorySearch] = useState("");
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [promptMode, setPromptMode] = useState('idea'); // 'idea' or 'prompt'
    const [aiSource, setAiSource] = useState('api'); // 'api' or 'addon'
    const [bridgeRunning, setBridgeRunning] = useState(false); // Bridge status
    const [extensionConnected, setExtensionConnected] = useState(false); // Extension status
    const [bridgeWaiting, setBridgeWaiting] = useState(false); // Bridge đang chờ extension kết nối
    const bridgeWaitingTimeoutRef = useRef(null); // Timeout auto-stop bridge
    // Global map lưu pending bridge callbacks theo requestId (fix race condition EventsOn)
    const bridgePendingRef = useRef({}); // { [requestId]: { resolve, reject, timeoutId } }
    const [promptDynamic, setPromptDynamic] = useState("");


    const [activeIdeaId, setActiveIdeaId] = useState(null);
    const [activeOriginalKeyword, setActiveOriginalKeyword] = useState("");

    // Idea Management States
    const [ideas, setIdeas] = useState([]);
    const [ideaSearch, setIdeaSearch] = useState("");
    const [ideaFilterCategory, setIdeaFilterCategory] = useState("");
    const [isLoadingIdeas, setIsLoadingIdeas] = useState(false);
    const [showPromptsModal, setShowPromptsModal] = useState(false);
    const [modalPrompts, setModalPrompts] = useState([]);
    const [selectedIdeaForModal, setSelectedIdeaForModal] = useState(null);
    const [isLoadingModalPrompts, setIsLoadingModalPrompts] = useState(false);
    const [selectedModalPromptIds, setSelectedModalPromptIds] = useState([]);
    const [promptSortStatus, setPromptSortStatus] = useState('default'); // 'default' | 'unused_first' | 'used_first'
    const [selectedManageIdeaIds, setSelectedManageIdeaIds] = useState([]); // Cho bảng Quản lý Ý tưởng
    const [ideaPage, setIdeaPage] = useState(1);
    const itemsPerPage = 10;

    // Gallery States
    const [galleryFolders, setGalleryFolders] = useState([]);
    const [selectedGalleryFolder, setSelectedGalleryFolder] = useState(null);
    const [galleryImages, setGalleryImages] = useState([]); // loaded images with base64
    const [galleryImageNames, setGalleryImageNames] = useState([]); // all image names (lightweight, no base64)
    const [galleryPage, setGalleryPage] = useState(1);
    const [galleryTotal, setGalleryTotal] = useState(0);
    const [galleryTotalPages, setGalleryTotalPages] = useState(0);
    const [isLoadingGallery, setIsLoadingGallery] = useState(false);
    const GALLERY_PAGE_SIZE = 30;
    const [previewImage, setPreviewImage] = useState(null); // { name, base64 }
    const [currentPreviewIndex, setCurrentPreviewIndex] = useState(-1);
    const [isLoadingFullImage, setIsLoadingFullImage] = useState(false);
    const [isExportingExcel, setIsExportingExcel] = useState(false);
    const [isSelectingDir, setIsSelectingDir] = useState(false);
    const [isUpscaling, setIsUpscaling] = useState(false);
    const [upscaleProgress, setUpscaleProgress] = useState(null); // { current, total, file }
    const [showExportMenu, setShowExportMenu] = useState(false);
    const [isSelectingImages, setIsSelectingImages] = useState(false);
    const [selectedImageNames, setSelectedImageNames] = useState([]);

    useEffect(() => {
        const handleProgress = (data) => {
            setUpscaleProgress(data);
        };
        EventsOn("upscale_progress", handleProgress);
        return () => EventsOff("upscale_progress");
    }, []);

    const supabase = config.supabaseUrl && config.supabaseKey
        ? createClient(config.supabaseUrl, config.supabaseKey)
        : null;

    useEffect(() => {
        if (activeTab === 'gallery') {
            fetchGalleryFolders();
        }
    }, [activeTab]);


    const fetchGalleryFolders = async () => {
        try {
            const folders = await GetGalleryFolders(config.output);
            if (folders && folders.length > 0) {
                setGalleryFolders(folders);
                if (!selectedGalleryFolder) {
                    handleSelectFolder(folders[0].name);
                }
            }
        } catch (e) {
            console.error("Lỗi khi tải thư mục Gallery:", e);
        }
    };

    const handleSelectFolder = async (folderName) => {
        setSelectedGalleryFolder(folderName);
        setCurrentPreviewIndex(-1);
        setGalleryImages([]);
        setGalleryPage(1);
        setIsLoadingGallery(true);
        try {
            // Load lightweight image names list (fast, no disk read of file contents)
            const namesList = await GetGalleryImageList(config.output, folderName);
            setGalleryImageNames(namesList || []);
            setGalleryTotal(namesList?.length || 0);
            setGalleryTotalPages(Math.ceil((namesList?.length || 0) / GALLERY_PAGE_SIZE));

            // Load only the first page of thumbnails
            const result = await GetGalleryImages(config.output, folderName, 1, GALLERY_PAGE_SIZE);
            setGalleryImages(result.images || []);
        } catch (e) {
            console.error("Lỗi khi tải ảnh Gallery:", e);
        } finally {
            setIsLoadingGallery(false);
        }
    };

    const handleLoadMoreGallery = async () => {
        if (isLoadingGallery || galleryPage >= galleryTotalPages) return;
        const nextPage = galleryPage + 1;
        setIsLoadingGallery(true);
        try {
            const result = await GetGalleryImages(config.output, selectedGalleryFolder, nextPage, GALLERY_PAGE_SIZE);
            if (result.images && result.images.length > 0) {
                setGalleryImages(prev => [...prev, ...result.images]);
                setGalleryPage(nextPage);
            }
        } catch (e) {
            console.error("Lỗi khi tải thêm ảnh:", e);
        } finally {
            setIsLoadingGallery(false);
        }
    };

    const handleNavigateImage = async (direction) => {
        // Navigate using the full image names list (not just loaded thumbnails)
        if (!galleryImageNames || galleryImageNames.length === 0 || currentPreviewIndex === -1) return;

        let newIndex = currentPreviewIndex + direction;
        if (newIndex < 0) newIndex = galleryImageNames.length - 1;
        if (newIndex >= galleryImageNames.length) newIndex = 0;

        const nextImg = galleryImageNames[newIndex];
        setIsLoadingFullImage(true);
        try {
            const fullB64 = await GetImageFullBase64(config.output, selectedGalleryFolder, nextImg.name);
            if (fullB64) {
                setPreviewImage({ name: nextImg.name, base64: fullB64 });
                setCurrentPreviewIndex(newIndex);
            }
        } catch (e) {
            console.error("Lỗi khi chuyển ảnh:", e);
        } finally {
            setIsLoadingFullImage(false);
        }
    };

    const handleDeleteImage = async () => {
        if (!previewImage || currentPreviewIndex === -1) return;

        // Use galleryImageNames (full list) for tracking position
        const imgToDelete = galleryImageNames[currentPreviewIndex];
        if (!imgToDelete) return;
        if (confirm(`Bạn có chắc muốn xóa ảnh này?`)) {
            try {
                const res = await DeleteImage(config.output, selectedGalleryFolder, imgToDelete.name);
                if (res === "Success") {
                    // Update both lists
                    const newNames = galleryImageNames.filter((_, idx) => idx !== currentPreviewIndex);
                    setGalleryImageNames(newNames);
                    setGalleryTotal(newNames.length);
                    // Also remove from loaded images if present
                    setGalleryImages(prev => prev.filter(img => img.name !== imgToDelete.name));

                    if (newNames.length === 0) {
                        setPreviewImage(null);
                        setCurrentPreviewIndex(-1);
                    } else {
                        // Move to next image or previous if at end
                        const nextIdx = currentPreviewIndex >= newNames.length ? newNames.length - 1 : currentPreviewIndex;
                        const nextImg = newNames[nextIdx];
                        const fullB64 = await GetImageFullBase64(config.output, selectedGalleryFolder, nextImg.name);
                        setPreviewImage({ name: nextImg.name, base64: fullB64 });
                        setCurrentPreviewIndex(nextIdx);
                    }
                    addLog(`Đã xóa ảnh: ${imgToDelete.name}`, "success");
                } else {
                    alert("Lỗi khi xóa ảnh: " + res);
                }
            } catch (e) {
                console.error("Lỗi khi xóa ảnh:", e);
            }
        }
    };

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!previewImage) return;
            if (e.key === 'ArrowLeft') {
                handleNavigateImage(-1);
            } else if (e.key === 'ArrowRight') {
                handleNavigateImage(1);
            } else if (e.key === 'Escape') {
                setPreviewImage(null);
                setCurrentPreviewIndex(-1);
            } else if (e.key === 'Delete') {
                handleDeleteImage();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewImage, currentPreviewIndex, galleryImageNames, selectedGalleryFolder]);

    useEffect(() => {
        if (supabase) {
            fetchCategories();
            fetchIdeas();
        }
    }, [config.supabaseUrl, config.supabaseKey]);

    useEffect(() => {
        setIdeaPage(1);
    }, [ideaSearch, ideaFilterCategory]);



    const fetchIdeas = async () => {
        if (!supabase) return;
        setIsLoadingIdeas(true);
        try {
            const { data, error } = await supabase
                .from('ideas')
                .select(`
                    *,
                    categories (name),
                    prompts (id, is_used)
                `)
                .order('created_at', { ascending: false });

            if (!error && data) {
                setIdeas(data);
            } else if (error) {
                addLog(`Lỗi khi lấy danh sách ý tưởng: ${error.message}`, 'error');
            }
        } finally {
            setIsLoadingIdeas(false);
        }
    };

    const fetchIdeaPrompts = async (ideaId) => {
        if (!supabase) return;
        setIsLoadingModalPrompts(true);
        try {
            const { data, error } = await supabase
                .from('prompts')
                .select('*')
                .eq('idea_id', ideaId)
                .order('created_at', { ascending: false });

            if (!error && data) {
                setModalPrompts(data);
            } else if (error) {
                addLog(`Lỗi khi lấy danh sách prompt: ${error.message}`, 'error');
            }
        } finally {
            setIsLoadingModalPrompts(false);
        }
    };

    const handleUpscaleImage = async () => {
        if (!previewImage || currentPreviewIndex === -1 || isUpscaling) return;

        const img = galleryImages[currentPreviewIndex];
        if (!confirm("Bạn muốn Phóng to x4 (Upscale) ảnh này chứ? Quá trình này có thể tốn 1-3 phút tùy vào cấu hình máy.")) return;

        setIsUpscaling(true);
        addLog(`Bắt đầu Upscale: ${img.name}...`, 'info');

        try {
            // Gửi các thành phần đường dẫn riêng biệt để Backend tự xử lý filepath.Join
            const result = await UpscaleImage(config.output, selectedGalleryFolder, img.name);
            if (result.startsWith("SUCCESS:")) {
                const newPath = result.replace("SUCCESS:", "");
                addLog(`Upscale thành công! File mới: ${newPath}`, 'success');
                alert(`Đã Upscale xong! \n\nFile mới: ${newPath}\n\nBạn có thể kiểm tra trong thư mục Album.`);
            } else if (result === "TOOL_NOT_FOUND") {
                addLog("Lỗi: Không tìm thấy công cụ Real-ESRGAN.", 'error');
                alert("Bạn chưa cài đặt công cụ Upscale.\n\nHãy tải 'realesrgan-ncnn-vulkan-v0.2.0-windows.zip' từ GitHub, giải nén và copy toàn bộ nội dung vào thư mục: \n\n[Thư mục App]/bin/realesrgan/");
            } else {
                addLog(`Lỗi Upscale: ${result}`, 'error');
                alert(`Có lỗi xảy ra: ${result}`);
            }
        } catch (e) {
            console.error("Lỗi gọi Upscale:", e);
            addLog(`Lỗi hệ thống khi Upscale: ${e}`, 'error');
        } finally {
            setIsUpscaling(false);
        }
    };

    const handleUpscaleFolder = async () => {
        if (!selectedGalleryFolder || isUpscaling) return;

        if (!confirm(`Bạn muốn Phóng to (Upscale) TOÀN BỘ ${galleryImages.length} ảnh trong album này chứ? \n\nLưu ý: Quá trình sẽ diễn ra tuần tự từng ảnh, có thể mất khá nhiều thời gian.`)) return;

        setIsUpscaling(true);
        setUpscaleProgress({ current: 0, total: galleryImages.length, file: "Đang khởi tạo..." });
        addLog(`Bắt đầu Upscale hàng loạt cho album: ${selectedGalleryFolder}...`, 'info');

        try {
            const result = await UpscaleFolder(config.output, selectedGalleryFolder);
            if (result.startsWith("SUCCESS:")) {
                addLog(`Hoàn tất Upscale hàng loạt: ${result.replace("SUCCESS: ", "")}`, 'success');
                alert(result.replace("SUCCESS: ", ""));
            } else if (result === "TOOL_NOT_FOUND") {
                addLog("Lỗi: Không tìm thấy công cụ Real-ESRGAN.", 'error');
                alert("Bạn chưa cài đặt công cụ Upscale.\n\nHãy tải 'realesrgan-ncnn-vulkan-v0.2.0-windows.zip' từ GitHub, giải nén và copy toàn bộ nội dung vào thư mục: \n\n[Thư mục App]/bin/realesrgan/");
            } else {
                addLog(`Lỗi Upscale: ${result}`, 'error');
                alert(`Có lỗi xảy ra: ${result}`);
            }
        } catch (e) {
            console.error("Lỗi gọi Upscale hàng loạt:", e);
            addLog(`Lỗi hệ thống khi Upscale hàng loạt: ${e}`, 'error');
        } finally {
            setIsUpscaling(false);
            setUpscaleProgress(null);
        }
    };

    const handleExportExcel = async () => {
        if (!selectedGalleryFolder) return;
        if (!config.geminiKey) {
            alert("Vui lòng cấu hình Gemini API Key trong thẻ Cài Đặt để tạo keywords!");
            setActiveTab('settings');
            return;
        }

        setIsExportingExcel(true);
        addLog(`Đang xuất báo cáo Excel cho album: ${selectedGalleryFolder}...`, 'info');
        try {
            const res = await ExportGalleryReport(config.output, selectedGalleryFolder, config.prefix, config.geminiKey);
            if (res.startsWith("Success:")) {
                const filePath = res.split(': ')[1];
                addLog(`Đã xuất báo cáo Excel thành công: ${filePath}`, 'success');
                alert(`Đã xuất file thành công!\nĐường dẫn: ${filePath}`);
            } else {
                addLog(`Lỗi khi xuất Excel: ${res}`, 'error');
                alert("Lỗi: " + res);
            }
        } catch (e) {
            addLog(`Lỗi ngoại lệ khi xuất Excel: ${e.message}`, 'error');
            alert("Lỗi: " + e.message);
        } finally {
            setIsExportingExcel(false);
        }
    };

    // Helper: strip HTML tags để lấy plain text từ ChatGPT response (trả về HTML)
    const stripHtml = (html) => {
        if (!html) return "";
        // Replace block elements with newlines first
        let text = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(p|div|li|tr|h[1-6])[^>]*>/gi, '\n');
        // Remove all remaining HTML tags
        text = text.replace(/<[^>]+>/g, '');
        // Decode HTML entities
        text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        return text;
    };

    // Hàm helper: tạo keywords cho 1 title qua addon (Bridge/ChatGPT)
    const generateKeywordsViaBridge = async (title) => {
        const keywordPrompt = `Act as a professional stock photographer's assistant.
Title: "${title}"
Task: Generate exactly 40 descriptive English keywords.
Rules:
1. Keywords must be single words.
2. Separate keywords with commas.
3. Only list keywords.`;

        const requestId = "kw_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                delete bridgePendingRef.current[requestId];
                reject(new Error("Quá thời gian chờ (2 phút)"));
            }, 120000);

            // Đăng ký callback vào global pending map (không dùng EventsOn để tránh ghi đè)
            bridgePendingRef.current[requestId] = {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    delete bridgePendingRef.current[requestId];
                    // Strip HTML tags trước (ChatGPT Bridge trả về HTML)
                    const plainText = stripHtml(data.content || "");
                    // Parse keywords: split by comma, clean up, allow multi-word, max 40
                    const words = plainText.split(',')
                        .map(w => w.trim().replace(/^[\d.\-\*\s]+/, '').replace(/[.!?]$/g, '').trim())
                        .filter(w => w.length > 0 && w.length < 50)
                        .slice(0, 40);
                    resolve(words.join(', '));
                },
                reject: (err) => {
                    clearTimeout(timeoutId);
                    delete bridgePendingRef.current[requestId];
                    reject(err);
                }
            };

            SendBridgePrompt(requestId, keywordPrompt).then(res => {
                if (res !== "ok") {
                    clearTimeout(timeoutId);
                    delete bridgePendingRef.current[requestId];
                    reject(new Error(res));
                }
            }).catch(err => {
                clearTimeout(timeoutId);
                delete bridgePendingRef.current[requestId];
                reject(err);
            });
        });
    };

    // Hàm helper: tạo keywords cho 1 title qua Gemini API
    const generateKeywordsViaGemini = async (title) => {
        const keywordPrompt = `Act as a professional stock photographer's assistant.
Title: "${title}"
Task: Generate exactly 40 descriptive English keywords.
Rules:
1. Keywords must be single words.
2. Separate keywords with commas.
3. Only list keywords.`;

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: keywordPrompt }] }]
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        if (data.candidates && data.candidates[0].content) {
            const text = data.candidates[0].content.parts[0].text;
            const words = text.split(',')
                .map(w => w.trim().replace(/[.!]/g, ''))
                .filter(w => w && !w.includes(' '))
                .slice(0, 40);
            return words.join(', ');
        }
        return "";
    };

    // Xuất báo cáo (Excel hoặc CSV) với keyword qua Addon hoặc API
    const handleExportWithKeywords = async (format, source) => {
        if (!selectedGalleryFolder) return;

        // Kiểm tra điều kiện theo nguồn AI
        if (source === 'api') {
            if (!config.geminiKey) {
                alert("Vui lòng cấu hình Gemini API Key trong thẻ Cài Đặt!");
                setActiveTab('settings');
                return;
            }
        } else if (source === 'addon') {
            if (!bridgeRunning || !extensionConnected) {
                alert("Vui lòng Bật Bridge và kết nối Chrome Extension trước!");
                return;
            }
        }

        setIsExportingExcel(true);
        setShowExportMenu(false);
        const formatLabel = format === 'excel' ? 'Excel' : 'CSV';
        const sourceLabel = source === 'api' ? 'Gemini API' : 'Addon (ChatGPT)';
        addLog(`Đang xuất ${formatLabel} (${sourceLabel}) cho album: ${selectedGalleryFolder}...`, 'info');

        try {
            // Nếu dùng API và xuất Excel → dùng hàm cũ (backend xử lý keyword)
            if (source === 'api' && format === 'excel') {
                const res = await ExportGalleryReport(config.output, selectedGalleryFolder, config.prefix, config.geminiKey);
                if (res.startsWith("Success:")) {
                    const filePath = res.split(': ')[1];
                    addLog(`Đã xuất ${formatLabel} thành công: ${filePath}`, 'success');
                    alert(`Đã xuất file thành công!\nĐường dẫn: ${filePath}`);
                } else {
                    addLog(`Lỗi xuất ${formatLabel}: ${res}`, 'error');
                    alert("Lỗi: " + res);
                }
                return;
            }

            // Nếu dùng API và xuất CSV không cần keywords → dùng hàm cũ
            if (source === 'api' && format === 'csv') {
                // Lấy titles, tạo keywords qua Gemini, rồi xuất CSV có keywords
                const titles = await GetAlbumTitles(config.output, selectedGalleryFolder, config.prefix);
                if (!titles || titles.length === 0) {
                    addLog("Không tìm thấy title nào trong album.", 'error');
                    alert("Lỗi: Không tìm thấy dữ liệu ảnh trong album.");
                    return;
                }

                addLog(`Đang tạo keywords cho ${titles.length} title qua Gemini API...`, 'info');
                const keywordsMap = {};
                for (let i = 0; i < titles.length; i++) {
                    const t = titles[i];
                    addLog(`[${i + 1}/${titles.length}] Đang tạo keywords: ${t.title.substring(0, 50)}...`, 'info');
                    try {
                        keywordsMap[t.title] = await generateKeywordsViaGemini(t.title);
                    } catch (e) {
                        addLog(`Lỗi tạo keywords cho "${t.title}": ${e.message}`, 'error');
                        keywordsMap[t.title] = "";
                    }
                }

                const res = await ExportCSVWithKeywords(config.output, selectedGalleryFolder, config.prefix, keywordsMap);
                if (res.startsWith("Success:")) {
                    const filePath = res.split(': ')[1];
                    addLog(`Đã xuất CSV thành công: ${filePath}`, 'success');
                    alert(`Đã xuất CSV thành công!\nĐường dẫn: ${filePath}`);
                } else {
                    addLog(`Lỗi xuất CSV: ${res}`, 'error');
                    alert("Lỗi: " + res);
                }
                return;
            }

            // Addon mode: Lấy danh sách titles → tạo keywords qua Bridge → ghi file
            const titles = await GetAlbumTitles(config.output, selectedGalleryFolder, config.prefix);
            if (!titles || titles.length === 0) {
                addLog("Không tìm thấy title nào trong album.", 'error');
                alert("Lỗi: Không tìm thấy dữ liệu ảnh trong album.");
                return;
            }

            addLog(`Đang tạo keywords cho ${titles.length} title qua Addon...`, 'info');
            const keywordsMap = {};

            for (let i = 0; i < titles.length; i++) {
                const t = titles[i];
                addLog(`[${i + 1}/${titles.length}] Đang tạo keywords: ${t.title.substring(0, 50)}...`, 'info');
                try {
                    keywordsMap[t.title] = await generateKeywordsViaBridge(t.title);
                    addLog(`  ✓ Đã tạo keywords cho: ${t.title.substring(0, 50)}`, 'success');
                } catch (e) {
                    addLog(`  ✗ Lỗi tạo keywords cho "${t.title}": ${e.message}`, 'error');
                    keywordsMap[t.title] = "";
                }
            }

            // Gọi backend để ghi file
            let res;
            if (format === 'excel') {
                res = await ExportGalleryReportWithKeywords(config.output, selectedGalleryFolder, config.prefix, keywordsMap);
            } else {
                res = await ExportCSVWithKeywords(config.output, selectedGalleryFolder, config.prefix, keywordsMap);
            }

            if (res.startsWith("Success:")) {
                const filePath = res.split(': ')[1];
                addLog(`Đã xuất ${formatLabel} thành công: ${filePath}`, 'success');
                alert(`Đã xuất file thành công!\nĐường dẫn: ${filePath}`);
            } else {
                addLog(`Lỗi xuất ${formatLabel}: ${res}`, 'error');
                alert("Lỗi: " + res);
            }
        } catch (e) {
            addLog(`Lỗi ngoại lệ khi xuất ${formatLabel}: ${e.message}`, 'error');
            alert("Lỗi: " + e.message);
        } finally {
            setIsExportingExcel(false);
        }
    };

    const handleDeleteIdeaFromSupabase = async (id) => {
        if (!supabase) return;
        const { error } = await supabase.from('ideas').delete().match({ id });
        if (error) {
            alert("Lỗi khi xóa ý tưởng: " + error.message);
        } else {
            setIdeas(prev => prev.filter(i => i.id !== id));
            addLog("Đã xóa ý tưởng khỏi Supabase", 'success');
        }
    };

    const fetchCategories = async () => {
        if (!supabase) return;
        const { data, error } = await supabase.from('categories').select('*').order('name');
        if (!error && data) setCategories(data);
    };

    const handleCreateCategory = async () => {
        if (!categorySearch.trim() || !supabase) return;

        const { data, error } = await supabase
            .from('categories')
            .insert([{ name: categorySearch.trim() }])
            .select();

        if (error) {
            alert("Lỗi khi tạo loại mới: " + error.message);
        } else if (data) {
            setCategories(prev => [...prev, data[0]].sort((a, b) => a.name.localeCompare(b.name)));
            setSelectedCategoryId(data[0].id);
            setCategorySearch("");
            setIsDropdownOpen(false);
            addLog(`Đã tạo loại mới: ${data[0].name}`, 'success');
        }
    };

    const handleBulkDelete = () => {
        const remaining = generatedPrompts.filter((_, idx) => !selectedIdeaIds.includes(idx));
        setGeneratedPrompts(remaining);
        setSelectedIdeaIds([]);
        addLog(`Đã xóa ${selectedIdeaIds.length} ý tưởng`, 'info');
    };

    const handleBulkCategorize = async () => {
        if (!selectedCategoryId) {
            alert("Vui lòng chọn loại ý tưởng!");
            return;
        }
        if (!supabase) {
            alert("Vui lòng cấu hình Supabase!");
            return;
        }

        const selectedIdeas = generatedPrompts.filter((_, idx) => selectedIdeaIds.includes(idx));

        for (const idea of selectedIdeas) {
            const { error: ideaErr } = await supabase.from('ideas').insert({
                category_id: selectedCategoryId,
                title: idea.title,
                commercial_goal: idea.commercial_goal,
                vibe: idea.vibe,
                subject_visual: idea.subject_visual,
                style_cues: idea.style_cues,
                original_keyword: idea.original_keyword,
                midjourney_prompt: [] // Luôn khởi tạo là mảng trống
            });

            if (ideaErr) {
                alert("Lỗi khi lưu ý tưởng: " + ideaErr.message);
            }
        }

        addLog(`Đã lưu thành công ${selectedIdeas.length} ý tưởng vào hệ thống!`, 'success');
        setGeneratedPrompts([]);
        setSelectedIdeaIds([]);
        fetchIdeas();
    };

    const handleBulkSavePrompts = async () => {
        if (!activeIdeaId) {
            alert("Vui lòng chọn 1 ý tưởng từ tab Quản lý ý tưởng trước!");
            return;
        }
        if (!supabase) {
            alert("Vui lòng cấu hình Supabase!");
            return;
        }

        const selectedPrompts = generatedPrompts.filter((_, idx) => selectedIdeaIds.includes(idx));
        const { data: insertedPrompts, error } = await supabase.from('prompts').insert(
            selectedPrompts.map(p => ({
                title: p.name || "",
                content: typeof p === 'object' ? p.content : p,
                idea_id: activeIdeaId,
                is_used: false
            }))
        ).select();

        if (error) {
            alert("Lỗi khi lưu prompt: " + error.message);
        } else {
            // Update the idea's midjourney_prompt array with new IDs
            const newIds = insertedPrompts.map(p => p.id);
            const { data: currentIdea } = await supabase.from('ideas').select('midjourney_prompt').eq('id', activeIdeaId).single();
            const updatedArray = [...(currentIdea?.midjourney_prompt || []), ...newIds];

            await supabase.from('ideas').update({ midjourney_prompt: updatedArray }).eq('id', activeIdeaId);

            addLog(`Đã lưu thành công ${selectedPrompts.length} prompt vào ý tưởng!`, 'success');
            setGeneratedPrompts([]);
            setSelectedIdeaIds([]);
            fetchIdeas(); // Tự động làm mới danh sách ý tưởng
        }
    };

    const toggleSelectAll = () => {
        if (selectedIdeaIds.length === generatedPrompts.length) {
            setSelectedIdeaIds([]);
        } else {
            setSelectedIdeaIds(generatedPrompts.map((_, idx) => idx));
        }
    };

    const toggleSelectOne = (idx) => {
        setSelectedIdeaIds(prev =>
            prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
        );
    };

    useEffect(() => {
        localStorage.setItem('bulkai_config', JSON.stringify(config));
    }, [config]);

    useEffect(() => {
        localStorage.setItem('bulkai_prompts', promptText);
    }, [promptText]);

    // Khởi tạo trạng thái Grok Chrome khi app load
    useEffect(() => {
        GetGrokChromeStatus().then(status => {
            setGrokChromeStatus(status || 'stopped');
        }).catch(() => { });
        GetGoogleFlowChromeStatus().then(status => {
            setGoogleFlowChromeStatus(status || 'stopped');
        }).catch(() => { });
        GetBridgeStatus().then(status => {
            if (status) {
                setBridgeRunning(status.running);
                setExtensionConnected(status.connected);
            }
        }).catch(() => { });
    }, []);

    useEffect(() => {
        checkSessionStatus();

        EventsOn("generation_progress", (data) => {
            setStatus({
                percentage: data.Percentage,
                estimated: data.Estimated
            });
            addLog(`Progress: ${Math.round(data.Percentage)}% - ETA: ${data.Estimated}`, 'progress');
        });

        EventsOn("generation_error", (err) => {
            addLog(`Lỗi: ${err}`, 'error');
            setIsGenerating(false);
        });

        // Grok Chrome status event
        EventsOn("grok_chrome_status", (status) => {
            setGrokChromeStatus(status);
        });

        // Grok log events
        EventsOn("grok_log", (data) => {
            addLog(data.msg, data.type || 'info');
        });

        // Google Flow Chrome status event
        EventsOn("gflow_chrome_status", (status) => {
            setGoogleFlowChromeStatus(status);
        });

        // Google Flow log events
        EventsOn("gflow_log", (data) => {
            addLog(data.msg, data.type || 'info');
        });

        EventsOn("generation_finished", async (albumID) => {
            addLog('Đã tạo ảnh xong', 'success');
            setIsGenerating(false);
            setStatus({ percentage: 100, estimated: '0m' });

            // Đọc config mới nhất từ localStorage (tránh stale closure)
            let currentConfig = config;
            try {
                const savedConfig = localStorage.getItem('bulkai_config');
                if (savedConfig) currentConfig = JSON.parse(savedConfig);
            } catch (e) { }

            const currentSupabase = currentConfig.supabaseUrl && currentConfig.supabaseKey
                ? createClient(currentConfig.supabaseUrl, currentConfig.supabaseKey)
                : null;

            if (albumID && albumID !== "Success" && currentSupabase) {
                try {
                    const dataStr = await GetAlbumData(currentConfig.output, albumID);
                    if (dataStr) {
                        const data = JSON.parse(dataStr);
                        addLog(`[Debug] Album data: ${data.prompts?.length || 0} prompts, ${data.finished?.length || 0} finished`, 'info');
                        if (data.finished && data.finished.length > 0 && data.prompts) {
                            const finishedPromptsText = data.finished.map(i => {
                                let p = data.prompts[i] || "";
                                // Strip prefix
                                if (currentConfig.prefix && p.startsWith(currentConfig.prefix)) {
                                    p = p.substring(currentConfig.prefix.length);
                                }
                                // Strip suffix (MJ suffix)
                                if (currentConfig.suffix && p.endsWith(currentConfig.suffix)) {
                                    p = p.substring(0, p.length - currentConfig.suffix.length);
                                }
                                // Strip grokSuffix (Grok suffix)
                                if (currentConfig.grokSuffix && p.endsWith(currentConfig.grokSuffix)) {
                                    p = p.substring(0, p.length - currentConfig.grokSuffix.length);
                                }
                                return p.trim();
                            });

                            addLog(`[Debug] Đang tìm ${finishedPromptsText.length} prompts để cập nhật: ${finishedPromptsText.map(p => p.substring(0, 50)).join(' | ')}`, 'info');

                            if (finishedPromptsText.length > 0) {
                                // Batch update để tránh lỗi "Bad Request" khi URL quá dài
                                const BATCH_SIZE = 10;
                                let totalUpdated = 0;
                                let batchError = null;

                                for (let i = 0; i < finishedPromptsText.length; i += BATCH_SIZE) {
                                    const batch = finishedPromptsText.slice(i, i + BATCH_SIZE);
                                    const { data, error } = await currentSupabase
                                        .from('prompts')
                                        .update({ is_used: true })
                                        .in('content', batch)
                                        .select();

                                    if (error) {
                                        batchError = error;
                                        addLog(`Lỗi cập nhật CSDL (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${error.message}`, 'error');
                                    } else {
                                        totalUpdated += (data?.length || 0);
                                    }
                                }

                                if (!batchError) {
                                    addLog(`Đã cập nhật trạng thái hoàn thành cho ${totalUpdated}/${finishedPromptsText.length} prompts trong dữ liệu.`, totalUpdated > 0 ? 'success' : 'warning');
                                    if (totalUpdated === 0) {
                                        addLog(`[Debug] Không tìm thấy prompt khớp trong DB. Prompt đầu tiên: "${finishedPromptsText[0]?.substring(0, 80)}"`, 'warning');
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error("Lỗi khi xử lý data.json báo kết quả:", e);
                    addLog(`[Debug] Lỗi update prompt: ${e.message}`, 'error');
                }
            }

            // Xóa danh sách prompt sau khi tạo ảnh xong và cập nhật CSDL
            setPromptText('');
            localStorage.removeItem('bulkai_prompts');
            addLog('Đã xóa danh sách prompt sau khi hoàn thành.', 'info');
        });

        EventsOn("bridge_status", (status) => {
            setBridgeRunning(status.running);
            setExtensionConnected(status.connected);
            // Khi extension đã kết nối → tắt trạng thái chờ và xóa timeout
            if (status.connected) {
                setBridgeWaiting(false);
                if (bridgeWaitingTimeoutRef.current) {
                    clearTimeout(bridgeWaitingTimeoutRef.current);
                    bridgeWaitingTimeoutRef.current = null;
                }
            }
            // Khi bridge tắt → reset trạng thái chờ
            if (!status.running) {
                setBridgeWaiting(false);
                if (bridgeWaitingTimeoutRef.current) {
                    clearTimeout(bridgeWaitingTimeoutRef.current);
                    bridgeWaitingTimeoutRef.current = null;
                }
            }
        });

        // ─── Global bridge_response dispatcher (1 listener duy nhất, dispatch theo requestId) ───
        // Giải quyết race condition: EventsOn chỉ giữ 1 listener/event name
        // Mọi pending request đều đăng ký callback vào bridgePendingRef.current
        EventsOn("bridge_response", (data) => {
            if (!data || !data.id) return;
            const pending = bridgePendingRef.current[data.id];
            if (!pending) return; // Không có request nào đang chờ với ID này
            if (data.status === 'success') {
                pending.resolve(data);
            } else {
                pending.reject(new Error(data.status || "Lỗi từ extension"));
            }
        });

        return () => {
            EventsOff("generation_progress");
            EventsOff("generation_error");
            EventsOff("generation_finished");
            EventsOff("grok_chrome_status");
            EventsOff("grok_log");
            EventsOff("gflow_chrome_status");
            EventsOff("gflow_log");
            EventsOff("bridge_status");
            EventsOff("bridge_response");
        };
    }, []);

    useEffect(() => {
        setIsSelectingImages(false);
        setSelectedImageNames([]);
        setShowExportMenu(false);
    }, [selectedGalleryFolder]);

    const checkSessionStatus = async () => {
        try {
            const info = await CheckSession();
            setSessionStatus(info.connected ? 'Connected' : 'Disconnected');
            if (info.connected) {
                setSessionUser({ username: info.username, avatar: info.avatar });
            } else {
                setSessionUser(null);
            }
        } catch (e) {
            setSessionStatus('Error');
            setSessionUser(null);
        }
    };

    const handleFetchSession = async () => {
        setIsFetchingSession(true);
        try {
            const result = await FetchSession();
            if (result === "Success") {
                await checkSessionStatus();
                addLog('Session synced successfully', 'success');
            } else {
                alert("Error fetching session: " + result);
            }
        } catch (e) {
            alert("Failed: " + e);
        }
        setIsFetchingSession(false);
    };

    const handleLogout = async () => {
        try {
            const result = await Logout();
            if (result === "Success") {
                setSessionStatus('Đã ngắt kết nối');
                setSessionUser(null);
                addLog('Đã ngắt kết nối thành công', 'info');
            } else {
                alert("Lỗi khi ngắt kết nối: " + result);
            }
        } catch (e) {
            alert("Lỗi: " + e);
        }
    };

    const handleSelectOutputDir = async () => {
        if (isSelectingDir) return;
        setIsSelectingDir(true);
        try {
            const path = await SelectDirectory();
            if (path) {
                setConfig({ ...config, output: path });
                addLog(`Đã thay đổi thư mục lưu trữ: ${path}`, 'success');
            }
        } catch (e) {
            console.error("Lỗi chọn thư mục:", e);
        } finally {
            setIsSelectingDir(false);
        }
    };

    const handleCheckUpdate = async () => {
        setIsCheckingUpdate(true);
        try {
            const info = await CheckUpdate();
            setUpdateInfo(info);
            if (!info.has_update) {
                addLog('Phần mềm đang ở phiên bản mới nhất.', 'success');
                alert("Bạn đang dùng phiên bản mới nhất!");
            } else {
                addLog(`Phát hiện bản cập nhật mới: ${info.version}`, 'success');
            }
        } catch (e) {
            addLog("Lỗi kiểm tra bản cập nhật: " + e, 'error');
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handlePerformUpdate = async () => {
        if (!updateInfo?.url) return;
        if (!confirm(`Bạn có chắc muốn cập nhật lên phiên bản ${updateInfo.version}? Không nên tắt ứng dụng trong quá trình cập nhật.`)) return;
        setIsUpdating(true);
        addLog('Đang tải và cài đặt bản cập nhật...', 'info');
        try {
            const res = await ApplyUpdate(updateInfo.url);
            if (res === "Success") {
                addLog('Cập nhật thành công! Vui lòng khởi động lại ứng dụng.', 'success');
                alert("Cập nhật thành công! Vui lòng tắt và mở lại phần mềm.");
                // Optionally close window automatically or ask user
            } else {
                addLog("Lỗi khi cập nhật: " + res, 'error');
                alert("Lỗi cập nhật: " + res);
            }
        } catch (e) {
            addLog("Lỗi ngoại lệ: " + e, 'error');
            alert("Lỗi ngoại lệ: " + e);
        } finally {
            setIsUpdating(false);
        }
    };

    const addLog = (msg, type = 'info') => {
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }].slice(-100));
    };

    const handleToggleGrokChrome = async () => {
        setIsTogglingChrome(true);
        try {
            if (grokChromeStatus === 'running') {
                await StopGrokChrome();
                setGrokChromeStatus('stopped');
                addLog('Đã tắt Chrome Grok', 'info');
            } else {
                addLog('Đang mở Chrome Grok... Vui lòng đăng nhập vào X/Grok nếu cần.', 'info');
                const result = await StartGrokChrome();
                if (result && result.startsWith('Error')) {
                    addLog('Lỗi khi mở Chrome: ' + result, 'error');
                } else {
                    setGrokChromeStatus('running');
                    addLog('Chrome Grok đã mở! Vui lòng đăng nhập vào grok.com nếu chưa đăng nhập.', 'success');
                }
            }
        } catch (e) {
            addLog('Lỗi Chrome: ' + e, 'error');
        } finally {
            setIsTogglingChrome(false);
        }
    };

    const handleToggleGoogleFlowChrome = async () => {
        setIsTogglingGFlowChrome(true);
        try {
            if (googleFlowChromeStatus === 'running' || googleFlowChromeStatus === 'waiting') {
                await StopGoogleFlowChrome();
                setGoogleFlowChromeStatus('stopped');
                addLog('Đã tắt Bridge Google Flow', 'info');
            } else {
                addLog('Đang khởi động Bridge WebSocket server...', 'info');
                const flowUrl = config.googleFlowUrl || 'https://flow.google.com/project';
                const result = await StartGoogleFlowChrome(flowUrl);
                if (result && result.startsWith('Error')) {
                    addLog('Lỗi khi mở Bridge: ' + result, 'error');
                } else {
                    setGoogleFlowChromeStatus('waiting');
                    addLog('✅ Bridge đã chạy! Đang chờ Chrome Extension kết nối...', 'info');
                    addLog('📋 Hướng dẫn: 1) Cài extension từ thư mục chrome-extension/ 2) Mở labs.google trong Chrome 3) Extension sẽ tự kết nối', 'info');
                }
            }
        } catch (e) {
            addLog('Lỗi Bridge: ' + e, 'error');
        } finally {
            setIsTogglingGFlowChrome(false);
        }
    };

    const handleToggleBridge = async () => {
        try {
            if (bridgeRunning) {
                // Xóa timeout nếu có
                if (bridgeWaitingTimeoutRef.current) {
                    clearTimeout(bridgeWaitingTimeoutRef.current);
                    bridgeWaitingTimeoutRef.current = null;
                }
                await StopBridge();
                setBridgeRunning(false);
                setExtensionConnected(false);
                setBridgeWaiting(false);
                addLog('Đã tắt Bridge', 'info');
            } else {
                addLog('Đang khởi động Bridge WebSocket server...', 'info');
                const result = await StartBridge();
                if (result && result.startsWith('error')) {
                    addLog('Lỗi khi mở Bridge: ' + result, 'error');
                } else {
                    setBridgeRunning(true);
                    setBridgeWaiting(true);
                    addLog('Bridge WebSocket server đã chạy! Đang chờ Chrome Extension kết nối (port 8765)...', 'info');

                    // Auto-stop sau 1 phút nếu extension không kết nối
                    if (bridgeWaitingTimeoutRef.current) {
                        clearTimeout(bridgeWaitingTimeoutRef.current);
                    }
                    bridgeWaitingTimeoutRef.current = setTimeout(async () => {
                        bridgeWaitingTimeoutRef.current = null;
                        // Kiểm tra lại trạng thái trước khi tắt
                        try {
                            const status = await GetBridgeStatus();
                            if (status && status.running && !status.connected) {
                                await StopBridge();
                                setBridgeRunning(false);
                                setExtensionConnected(false);
                                setBridgeWaiting(false);
                                addLog('Bridge đã tự tắt do không có Extension kết nối sau 1 phút.', 'warning');
                            }
                        } catch (e) {
                            console.error('Lỗi auto-stop bridge:', e);
                        }
                    }, 60000);
                }
            }
        } catch (e) {
            addLog('Lỗi Bridge: ' + e, 'error');
        }
    };

    const handleDeleteSelectedImages = async () => {
        if (selectedImageNames.length === 0) return;
        if (!confirm(`Bạn có chắc muốn XÓA ${selectedImageNames.length} ảnh đã chọn? Hành động này không thể hoàn tác!`)) return;

        addLog(`Đang xóa ${selectedImageNames.length} ảnh đã chọn...`, 'info');
        try {
            let successCount = 0;
            for (const name of selectedImageNames) {
                const res = await DeleteImage(config.output, selectedGalleryFolder, name);
                if (res.startsWith("Success:")) {
                    successCount++;
                } else {
                    addLog(`Lỗi xóa ảnh ${name}: ${res}`, 'error');
                }
            }
            addLog(`Đã xóa thành công ${successCount}/${selectedImageNames.length} ảnh.`, 'success');
            // Refresh using paginated API
            setSelectedImageNames([]);
            setIsSelectingImages(false);
            handleSelectFolder(selectedGalleryFolder);
        } catch (e) {
            addLog(`Lỗi khi xóa các ảnh đã chọn: ${e.message}`, 'error');
        }
    };

    const handleSelectAllImages = () => {
        if (selectedImageNames.length === galleryImages.length) {
            setSelectedImageNames([]);
        } else {
            // Select all currently loaded images
            setSelectedImageNames(galleryImages.map(img => img.name));
        }
    };

    const handleCancelSelection = () => {
        setIsSelectingImages(false);
        setSelectedImageNames([]);
    };

    const stopGeneration = async () => {
        addLog('⏹️ Đang dừng quá trình tạo ảnh...', 'warning');
        try {
            const result = await StopGoogleFlowGeneration();
            addLog(`⏹️ ${result === 'Stopped' ? 'Đã dừng!' : result}`, result === 'Stopped' ? 'info' : 'warning');
        } catch (e) {
            addLog('❌ Lỗi khi dừng: ' + e, 'error');
        }
    };

    const startGeneration = () => {
        // --- Google Flow ---
        if (config.bot === 'google_flow') {
            if (googleFlowChromeStatus !== 'running') {
                addLog('Lỗi: Bridge chưa kết nối Extension. Vui lòng nhấn "Bật Bridge" và cài Extension.', 'error');
                return;
            }
            const prompts = promptText.split('\n').map(p => p.trim()).filter(p => p !== '').map(p => replaceBannedWords(p));
            if (prompts.length === 0) {
                addLog('Lỗi: Danh sách prompt trống', 'error');
                return;
            }
            setIsGenerating(true);
            setStatus({ percentage: 0, estimated: 'Đang xử lý...' });
            setLogs([]);
            addLog(`🎨 Đang khởi tạo Google Flow generation...`, 'info');
            addLog(`Gửi ${prompts.length} prompt tới Google Flow qua Bridge...`, 'info');
            GenerateGoogleFlowImages({
                prompts: prompts,
                output: config.output,
                album: '',
                download: config.download,
                flowUrl: config.googleFlowUrl || 'https://flow.google.com/project',
                delay: parseInt(config.googleFlowDelay) || 10
            }).then(result => {
                if (result && result.startsWith && result.startsWith('Error')) {
                    addLog('❌ ' + result, 'error');
                    setIsGenerating(false);
                }
            });
            return;
        }

        // --- Grok flow ---
        if (config.bot === 'grok' || config.bot === 'grok_imagine') {
            if (grokChromeStatus !== 'running') {
                addLog('Lỗi: Chrome Grok chưa chạy. Vui lòng nhấn "Bật Chrome" trước.', 'error');
                return;
            }
            const prompts = promptText.split('\n').map(p => p.trim()).filter(p => p !== '').map(p => replaceBannedWords(p));
            if (prompts.length === 0) {
                addLog('Lỗi: Danh sách prompt trống', 'error');
                return;
            }
            const isImagine = config.bot === 'grok_imagine';
            setIsGenerating(true);
            setStatus({ percentage: 0, estimated: 'Đang xử lý...' });
            setLogs([]);
            addLog(`🤖 Đang khởi tạo Grok ${isImagine ? '/imagine' : 'chat'} generation...`, 'info');
            addLog(`Gửi ${prompts.length} prompt tới Grok (xAI)${isImagine ? ' - Imagine' : ''}...`, 'info');
            GenerateGrokImages({
                prompts: prompts,
                ratio: config.grokRatio || '1:1',
                count: config.grokCount || 2,
                output: config.output,
                album: '',
                download: config.download,
                suffix: config.grokSuffix || '',
                useImagine: isImagine
            });
            return;
        }

        // --- Discord-based flow (MJ, BlueWillow) ---
        if (sessionStatus !== 'Connected') {
            addLog('Lỗi: Bạn chưa đồng bộ phiên Discord. Hãy vào Cài đặt để kết nối.', 'error');
            setActiveTab('settings');
            return;
        }

        const prompts = promptText.split('\n').map(p => p.trim()).filter(p => p !== '').map(p => replaceBannedWords(p));
        if (prompts.length === 0) {
            addLog('Lỗi: Danh sách prompt trống', 'error');
            return;
        }

        setIsGenerating(true);
        setStatus({ percentage: 0, estimated: 'Khởi tạo...' });
        setLogs([]);
        addLog('🚀 Đang khởi tạo tiến trình sinh ảnh...', 'info');
        addLog(`Đang gửi ${prompts.length} prompt đến ${config.bot.toUpperCase()}...`, 'info');

        GenerateImages({
            ...config,
            prompts: prompts
        });
    };

    const handleGeneratePrompt = async () => {
        if (!promptIdea) {
            alert("Vui lòng nhập ý tưởng!");
            return;
        }
        if (aiSource === 'api') {
            if (promptPlatform !== 'gemini' && !config.openaiKey) {
                alert("Vui lòng cấu hình OpenAI API Key trong thẻ Cài Đặt!");
                return;
            }
            if (promptPlatform === 'gemini' && !config.geminiKey) {
                alert("Vui lòng cấu hình Gemini API Key trong thẻ Cài Đặt!");
                return;
            }
        }

        setIsGeneratingPrompt(true);
        setGeneratedPrompts([]);

        // Lấy danh sách prompt cũ để tránh trùng lặp nếu đang trong mode tạo prompt cho idea đã có
        let existingPromptsText = "";
        if (promptMode === 'prompt' && activeIdeaId) {
            const { data: oldPrompts } = await supabase
                .from('prompts')
                .select('content')
                .eq('idea_id', activeIdeaId);

            if (oldPrompts && oldPrompts.length > 0) {
                existingPromptsText = "\n\nDANH SÁCH PROMPT ĐÃ CÓ (KHÔNG ĐƯỢC TRÙNG LẶP Ý TƯỞNG VÀ NGỮ NGHĨA VỚI CÁC DÒNG NÀY):\n" +
                    oldPrompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n");
            }
        }

        const systemPrompt = promptMode === 'idea'
            ? `VAI TRÒ CỦA BẠN:
Bạn là một Chuyên gia Định hướng Sáng tạo (Creative Strategist) chuyên về thị trường ảnh Microstock (đặc biệt là Adobe Stock). Nhiệm vụ của bạn là nhận từ khóa từ tôi và phác thảo các định hướng concept có giá trị thương mại cao.

NGUYÊN TẮC CỐT LÕI:
1. KHÔNG mô tả chi tiết hình ảnh, sự vật hay ánh sáng cụ thể. Bạn chỉ cung cấp "đề bài sáng tạo" (Creative Brief) để tôi có không gian tự do phát triển thành prompt Midjourney.
2. ĐỊNH DẠNG BẮT BUỘC: Mọi kết quả phân tích phải được trình bày duy nhất dưới dạng 1 Bảng (Table). Không sử dụng định dạng danh sách liệt kê dài dòng.

QUY TRÌNH LÀM VIỆC:
Khi tôi cung cấp một từ khóa, hãy suy nghĩ và đề xuất đúng ${promptCount} hướng tiếp cận (Concept) hoàn toàn khác nhau về phong cách cho ${promptIdea}. Điền các thông tin vào một bảng có cấu trúc các cột như sau:

Cột 1: Tên Concept (Tên hướng tiếp cận ngắn gọn. VD: Tối giản & Hữu cơ, Không gian mạng tương lai...)
Cột 2: Cách thể hiện Chủ thể (Mô tả trực diện vật lý: Từ khóa của tôi sẽ xuất hiện dưới hình dáng, trạng thái hay hành động cụ thể nào trong ảnh để không bị lạc đề?).
Cột 3: Mục Tiêu Thương Mại (Nhắm đến ai? Dùng làm gì? VD: Bao bì nông sản chế biến, banner website...)
Cột 4: Cảm Xúc (Vibe) (2-3 tính từ miêu tả cảm giác tổng thể. VD: Mộc mạc, đáng tin cậy...)
Cột 5: Style Cues (2-3 từ khóa phong cách nghệ thuật cốt lõi làm nguyên liệu viết prompt. VD: Flatlay, Minimalism...)
TỪ KHÓA CẤM: TUYỆT ĐỐI KHÔNG được sử dụng các từ sau trong bất kỳ nội dung nào: "cutting", "thick", "transparent". Hãy thay thế bằng từ đồng nghĩa phù hợp nếu cần.  
LƯU Ý ĐỊNH DẠNG: BẮT BUỘC đặt toàn bộ bảng kết quả bên trong một khối code markdown (dùng ). Không viết bảng bên ngoài khối code.

`
            : `VAI TRÒ CỦA BẠN:
Bạn là một Chuyên gia Kỹ sư Prompt và Giám đốc Hình ảnh AI hàng đầu. Nhiệm vụ của bạn là nhận các mô tả concept/ý tưởng sơ khai và biến chúng thành ${promptCount} prompt Midjourney tiếng Anh chi tiết, tối ưu và mang tính thẩm mỹ cao nhất.

CẤU TRÚC PROMPT BẮT BUỘC:
Mô tả concept gốc: ${promptIdea}
Mỗi prompt bạn tạo ra phải tuân theo công thức nhiếp ảnh và thiết kế tiêu chuẩn, prompt tập trung vào chủ thể chính là ${activeOriginalKeyword || '(từ khóa gốc)'}:
[Subject: Chủ thể chính] + [Environment: Bối cảnh xung quanh] + [Lighting: Kỹ thuật ánh sáng] + [Camera Angles & Lens: Góc máy & Ống kính] + [Art Style/Texture: Phong cách/Chất liệu]

YÊU CẦU PHẢN HỒI:
1. Bạn phải tự đặt tên (NAME) sáng tạo và mang tính thương mại cho từng phương án.
2. Mỗi phương án trình bày theo cấu trúc:

NAME: [Tên sáng tạo]
PROMPT: [Nội dung prompt theo cấu trúc nhiếp ảnh trên]

3. Sử dụng "---" để ngăn cách giữa các phương án.
4. KHÔNG thêm các Midjourney parameters (--ar, --v...).
5. Trả về đủ ${promptCount} phương án.
Yêu cầu thêm: ${promptDynamic || 'Không có'}

${existingPromptsText}

LƯU Ý QUAN TRỌNG: Bạn phải tạo ra các phương án hoàn toàn mới, không được lặp lại góc nhìn, bối cảnh hay cách tiếp cận của các prompt đã có ở trên.${bannedWords.length > 0 ? `

CÁC TỪ CẤM - KHÔNG ĐƯỢC SỬ DỤNG (phải dùng từ thay thế tương ứng):
${bannedWords.map(w => `- "${w.banned}" → thay bằng "${w.replacement || '(bỏ đi)'}" `).join('\n')}` : ''}`;

        try {
            let resultText = "";
            if (aiSource === 'addon') {
                if (!bridgeRunning || !extensionConnected) {
                    alert("Vui lòng Bật Bridge và kết nối Chrome Extension trước!");
                    setIsGeneratingPrompt(false);
                    return;
                }

                const requestId = "prompt_gen_" + Date.now();
                addLog(`Đang gửi yêu cầu tạo prompt tới Chrome Extension [ID: ${requestId}]...`, 'info');

                resultText = await new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(() => {
                        delete bridgePendingRef.current[requestId];
                        reject(new Error("Quá thời gian chờ phản hồi từ ChatGPT (2 phút). Kiểm tra ChatGPT đang mở và Extension đang kết nối."));
                    }, 120000);

                    // Đăng ký callback vào global pending map (không dùng EventsOn để tránh ghi đè)
                    bridgePendingRef.current[requestId] = {
                        resolve: (data) => {
                            clearTimeout(timeoutId);
                            delete bridgePendingRef.current[requestId];
                            if (data.status === 'success') {
                                resolve(data.content);
                            } else {
                                reject(new Error(data.status || "Lỗi từ extension"));
                            }
                        },
                        reject: (err) => {
                            clearTimeout(timeoutId);
                            delete bridgePendingRef.current[requestId];
                            reject(err);
                        }
                    };

                    SendBridgePrompt(requestId, systemPrompt).then(res => {
                        if (res !== "ok") {
                            clearTimeout(timeoutId);
                            delete bridgePendingRef.current[requestId];
                            reject(new Error(res));
                        }
                    }).catch(err => {
                        clearTimeout(timeoutId);
                        delete bridgePendingRef.current[requestId];
                        reject(err);
                    });
                });
            } else if (promptPlatform !== 'gemini') {
                const res = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openaiKey}` },
                    body: JSON.stringify({
                        model: promptPlatform,
                        messages: [{ role: "user", content: systemPrompt }]
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                resultText = data.choices[0].message.content;
            } else {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: systemPrompt }] }]
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                if (data.candidates && data.candidates[0].content) {
                    resultText = data.candidates[0].content.parts[0].text;
                } else {
                    throw new Error("Phản hồi từ Gemini không hợp lệ.");
                }
            }

            // Parse result
            // If the response is wrapped in HTML from the extension DOM scraper, convert it to clean plain text first
            let htmlTableRows = null;
            if (resultText && resultText.includes("<") && resultText.includes(">")) {
                try {
                    const tempDiv = document.createElement("div");
                    tempDiv.innerHTML = resultText;
                    
                    // 1. Check if there's an HTML <table> tag (rich table rendered by browser/ChatGPT)
                    const tableEl = tempDiv.querySelector("table");
                    if (tableEl) {
                        const trElements = tableEl.querySelectorAll("tr");
                        const parsedRows = [];
                        for (let tr of trElements) {
                            const cells = tr.querySelectorAll("th, td");
                            if (cells.length >= 5) {
                                const rowData = Array.from(cells).map(c => c.textContent.trim());
                                parsedRows.push(rowData);
                            }
                        }
                        if (parsedRows.length > 0) {
                            htmlTableRows = parsedRows;
                        }
                    }
                    
                    if (!htmlTableRows) {
                        // 2. Priority: find <code> FIRST (deepest, cleanest content without toolbar text)
                        //    ChatGPT structure: <pre> > [toolbar div with "Markdown"/"Copy"] + <code> (actual content)
                        //    IMPORTANT: ChatGPT uses <span>line</span><br><span>line</span> inside <code>,
                        //    and .textContent ignores <br> so all lines collapse into one string!
                        //    Must replace <br> with \n BEFORE extracting textContent.
                        const codeEl = tempDiv.querySelector("code");
                        const preEl = tempDiv.querySelector("pre");
                        const targetEl = codeEl || preEl;
                        
                        if (targetEl) {
                            // Replace ALL <br> elements with newline text nodes to preserve line breaks
                            targetEl.querySelectorAll("br").forEach(br => {
                                br.replaceWith("\n");
                            });
                            resultText = targetEl.textContent || targetEl.innerText || "";
                        } else {
                            // No code/pre tags - preserve newlines from block-level elements
                            tempDiv.querySelectorAll("br").forEach(br => {
                                const newline = document.createTextNode("\n");
                                if (br.parentNode) br.parentNode.replaceChild(newline, br);
                            });
                            const blockTags = ["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre"];
                            blockTags.forEach(tag => {
                                tempDiv.querySelectorAll(tag).forEach(el => {
                                    const val = el.textContent || el.innerText || "";
                                    if (val && !val.endsWith("\n")) {
                                        el.appendChild(document.createTextNode("\n"));
                                    }
                                });
                            });
                            resultText = tempDiv.textContent || tempDiv.innerText || "";
                        }
                    }
                } catch (e) {
                    resultText = resultText.replace(/<[^>]*>/g, "");
                }
            }

            if (promptMode === 'idea') {
                let rows = [];
                if (htmlTableRows) {
                    // Filter headers/dividers from HTML table rows
                    rows = htmlTableRows.filter(cols => {
                        if (cols.some(c => c.includes('---'))) return false;
                        const firstColLower = (cols[0] || '').toLowerCase().trim();
                        if (firstColLower.includes('tên concept') || firstColLower.includes('concept name') || firstColLower === 'stt' || firstColLower === '#') return false;
                        return true;
                    });
                } else {
                    // Try to extract content inside the first markdown code block if it exists
                    const codeBlockMatch = resultText.match(/```(?:markdown|table|)?\n([\s\S]*?)\n```/);
                    const targetText = codeBlockMatch ? codeBlockMatch[1] : resultText;

                    // Extract only the first contiguous block of lines containing '|'
                    const lines = targetText.split('\n');
                    let tableLines = [];
                    let inTable = false;

                    for (let line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.includes('|')) {
                            inTable = true;
                            tableLines.push(trimmed);
                        } else if (inTable) {
                            break; // Stop as soon as the first table ends
                        }
                    }

                    rows = tableLines
                        .map(line => {
                            let temp = line;
                            if (temp.startsWith('|')) temp = temp.slice(1);
                            if (temp.endsWith('|')) temp = temp.slice(0, -1);
                            return temp.split('|').map(c => c.trim());
                        })
                        .filter(cols => {
                            if (cols.length < 5) return false;
                            if (cols.some(c => c.includes('---'))) return false;
                            const firstColLower = (cols[0] || '').toLowerCase().trim();
                            if (firstColLower.includes('tên concept') || firstColLower.includes('concept name') || firstColLower === 'stt' || firstColLower === '#') return false;
                            const isHeader = cols.some(c => {
                                const val = c.toLowerCase().trim();
                                return val === 'tên concept' || val === 'cách thể hiện chủ thể' || val === 'mục tiêu thương mại' || val === 'cảm xúc (vibe)' || val === 'style cues';
                            });
                            return !isHeader;
                        });
                }

                const parsedIdeas = rows.map(cols => ({
                    title: cols[0] || '',
                    subject_visual: cols[1] || '',
                    commercial_goal: cols[2] || '',
                    vibe: cols[3] || '',
                    style_cues: cols[4] || '',
                    original_keyword: promptIdea // Lưu lại từ khóa gốc
                }));
                setGeneratedPrompts(parsedIdeas);
            } else {
                // Advanced regex parsing to find all NAME/PROMPT pairs
                const regex = /NAME:\s*(.*?)\s*\n\s*PROMPT:\s*([\s\S]*?)(?=\n\s*NAME:|\n\s*---|$)/g;
                let match;
                const parsedPrompts = [];
                while ((match = regex.exec(resultText)) !== null) {
                    parsedPrompts.push({
                        name: match[1].trim(),
                        content: match[2].trim()
                    });
                }

                if (parsedPrompts.length === 0) {
                    const fallback = resultText.split('\n')
                        .map(l => l.trim())
                        .filter(l => /^\d+[\.\)]\s+/.test(l) || /^[-*]\s+/.test(l))
                        .map(l => l.replace(/^\d+[\.\)]\s+/, '').replace(/^[-*]\s+/, ''));
                    setGeneratedPrompts(fallback.map(p => ({ name: "Prompt", content: p })));
                } else {
                    setGeneratedPrompts(parsedPrompts);
                }
            }

        } catch (e) {
            alert("Lỗi khi gọi API: " + e.message);
        }
        setIsGeneratingPrompt(false);
    };

    return (
        <div className="relative flex h-screen bg-appbg text-white overflow-hidden font-sans">
            {/* Absolute Diagonal Gradient background from the image */}
            <div className="bg-diagonal" />

            {/* SIDEBAR */}
            <div className="w-24 md:w-80 flex flex-col z-10 shrink-0 border-r border-white/[0.05] bg-[#0B0D15]">
                <div className="flex items-center gap-4 mb-10 px-6 pt-8">
                    <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center shadow-glow shrink-0 p-1.5 border border-white/[0.05]">
                        <img src={logo} alt="BulkAI Logo" className="w-10 h-10 object-contain" />
                    </div>
                    <div className="hidden md:block">
                        <h1 className="text-2xl font-bold tracking-wide">BulkAI</h1>
                        <p className="text-xs text-textSoft tracking-widest uppercase mt-0.5">Generator</p>
                    </div>
                </div>

                <nav className="flex flex-col">
                    <button
                        onClick={() => setActiveTab('prompt')}
                        className={`px-6 py-5 flex items-center gap-4 text-sm font-semibold transition-all group border-l-4 ${activeTab === 'prompt' ? 'bg-accentEnd/10 text-accentEnd border-accentEnd shadow-[inset_0_0_20px_rgba(0,210,255,0.05)]' : 'text-textSoft hover:text-white hover:bg-white/[0.02] border-transparent'
                            }`}
                    >
                        <Zap size={20} className={activeTab === 'prompt' ? 'text-accentEnd' : ''} />
                        <span className="hidden md:block flex-1 text-left">Tạo Prompt</span>
                        {activeTab === 'prompt' && <ChevronRight size={18} className="hidden md:block opacity-60" />}
                    </button>

                    <button
                        onClick={() => { setActiveTab('ideas_mgmt'); fetchIdeas(); }}
                        className={`px-6 py-5 flex items-center gap-4 text-sm font-semibold transition-all group border-l-4 ${activeTab === 'ideas_mgmt' ? 'bg-accentEnd/10 text-accentEnd border-accentEnd shadow-[inset_0_0_20px_rgba(0,210,255,0.05)]' : 'text-textSoft hover:text-white hover:bg-white/[0.02] border-transparent'
                            }`}
                    >
                        <ImageIcon size={20} className={activeTab === 'ideas_mgmt' ? 'text-accentEnd' : ''} />
                        <span className="hidden md:block flex-1 text-left">Quản lý ý tưởng</span>
                        {activeTab === 'ideas_mgmt' && <ChevronRight size={18} className="hidden md:block opacity-60" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('generator')}
                        className={`px-6 py-5 flex items-center gap-4 text-sm font-semibold transition-all group border-l-4 ${activeTab === 'generator' ? 'bg-accentEnd/10 text-accentEnd border-accentEnd shadow-[inset_0_0_20px_rgba(0,210,255,0.05)]' : 'text-textSoft hover:text-white hover:bg-white/[0.02] border-transparent'
                            }`}
                    >
                        <LayoutDashboard size={20} className={activeTab === 'generator' ? 'text-accentEnd' : ''} />
                        <span className="hidden md:block flex-1 text-left">Tạo Ảnh</span>
                        {activeTab === 'generator' && <ChevronRight size={18} className="hidden md:block opacity-60" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('settings')}
                        className={`px-6 py-5 flex items-center gap-4 text-sm font-semibold transition-all group border-l-4 ${activeTab === 'settings' ? 'bg-accentEnd/10 text-accentEnd border-accentEnd shadow-[inset_0_0_20px_rgba(0,210,255,0.05)]' : 'text-textSoft hover:text-white hover:bg-white/[0.02] border-transparent'
                            }`}
                    >
                        <Settings size={20} className={activeTab === 'settings' ? 'text-accentEnd' : ''} />
                        <span className="hidden md:block flex-1 text-left">Cài Đặt</span>
                        {activeTab === 'settings' && <ChevronRight size={18} className="hidden md:block opacity-60" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('gallery')}
                        className={`px-6 py-5 flex items-center gap-4 text-sm font-semibold transition-all group border-l-4 ${activeTab === 'gallery' ? 'bg-accentEnd/10 text-accentEnd border-accentEnd shadow-[inset_0_0_20px_rgba(0,210,255,0.05)]' : 'text-textSoft hover:text-white hover:bg-white/[0.02] border-transparent'
                            }`}
                    >
                        <ImageIcon size={20} className={activeTab === 'gallery' ? 'text-accentEnd' : ''} />
                        <span className="hidden md:block flex-1 text-left">Thư Viện Ảnh</span>
                        {activeTab === 'gallery' && <ChevronRight size={18} className="hidden md:block opacity-60" />}
                    </button>


                </nav>

                <div className="mt-auto px-6 py-8 border-t border-white/[0.03]">
                    <div className="flex items-center gap-4 group cursor-default">
                        <div className="relative">
                            {sessionUser?.avatar ? (
                                <img
                                    src={sessionUser.avatar}
                                    alt={sessionUser.username || 'User Avatar'}
                                    className="w-12 h-12 rounded-xl object-cover border border-white/10 shadow-glow-sm transition-transform group-hover:scale-105"
                                />
                            ) : (
                                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#1D2130] to-[#141620] flex items-center justify-center border border-white/5 shadow-inner">
                                    <UserCircle className="w-6 h-6 text-textSoft" />
                                </div>
                            )}
                            <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-[#0B0D15] flex items-center justify-center ${sessionStatus === 'Connected' ? 'bg-accentEnd' : 'bg-red-500'}`}>
                                <div className={`w-1.5 h-1.5 rounded-full bg-white ${sessionStatus === 'Connected' ? 'animate-pulse' : ''}`} />
                            </div>
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white truncate tracking-tight">
                                {sessionUser?.username || 'Chưa đăng nhập'}
                            </p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                                <span className={`text-[10px] font-black uppercase tracking-[0.15em] ${sessionStatus === 'Connected' ? 'text-accentEnd' : 'text-red-400'}`}>
                                    {sessionStatus === 'Connected' ? 'Đang kết nối' : 'Đã ngắt'}
                                </span>
                            </div>
                        </div>

                        {sessionStatus === 'Connected' && (
                            <div className="w-2 h-2 rounded-full bg-accentEnd shadow-glow-sm" />
                        )}
                    </div>
                </div>
            </div>

            {/* MAIN CONTENT */}
            <div className="flex-1 flex flex-col p-6 z-10 overflow-hidden relative isolate">
                <header className="flex justify-between items-center mb-8 shrink-0">
                    <h2 className="text-3xl font-bold tracking-wide">
                        {activeTab === 'prompt' && 'Tạo Prompt Trợ Lý AI'}
                        {activeTab === 'ideas_mgmt' && 'Quản lý ý tưởng'}
                        {activeTab === 'generator' && 'Cài Đặt Trình Tạo'}
                        {activeTab === 'settings' && 'Cài Đặt Hệ Thống'}
                        {activeTab === 'gallery' && 'Thư Viện Ảnh'}

                    </h2>
                    {/* Top right pill indicator */}
                    <div className="neumorphic-card px-6 py-3 flex items-center gap-2 border border-white/5">
                        <span className="text-xs text-textSoft uppercase tracking-widest font-semibold">Nền tảng Bot:</span>
                        <span className="text-sm font-bold text-accentEnd uppercase">{
                            {midjourney: 'Midjourney', bluewillow: 'Bluewillow', grok: 'Grok Chat', grok_imagine: 'Grok Imagine', google_flow: 'Google Flow'}[config.bot] || config.bot
                        }</span>
                    </div>
                </header>

                <div className="flex-1 overflow-y-auto pr-4 pb-6 flex flex-col scrollbar">
                    {activeTab === 'prompt' && (
                        <div className="flex-1 flex flex-col gap-6 h-full min-h-0">
                            {/* Panel Nhập liệu (Compact) */}
                            <div className="neumorphic-panel p-6 space-y-4 flex-none border-white/5">
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    <div className="space-y-3 lg:col-span-2">
                                        <div className="flex items-center gap-6 mb-1">
                                            <label className="flex items-center gap-2 cursor-pointer group">
                                                <input
                                                    type="radio"
                                                    className="sr-only"
                                                    name="promptMode"
                                                    checked={promptMode === 'idea'}
                                                    onChange={() => {
                                                        setPromptMode('idea');
                                                        setPromptCount(10);
                                                    }}
                                                />
                                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${promptMode === 'idea' ? 'border-accentEnd bg-accentEnd/20' : 'border-white/20'}`}>
                                                    {promptMode === 'idea' && <div className="w-2 h-2 rounded-full bg-accentEnd shadow-glow-sm" />}
                                                </div>
                                                <span className={`text-sm font-bold transition-colors ${promptMode === 'idea' ? 'text-white' : 'text-textSoft'}`}>Tạo ý tưởng</span>
                                            </label>
                                            <label className="flex items-center gap-2 cursor-pointer group">
                                                <input
                                                    type="radio"
                                                    className="sr-only"
                                                    name="promptMode"
                                                    checked={promptMode === 'prompt'}
                                                    onChange={() => {
                                                        setPromptMode('prompt');
                                                        setPromptCount(5);
                                                    }}
                                                />
                                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${promptMode === 'prompt' ? 'border-accentEnd bg-accentEnd/20' : 'border-white/20'}`}>
                                                    {promptMode === 'prompt' && <div className="w-2 h-2 rounded-full bg-accentEnd shadow-glow-sm" />}
                                                </div>
                                                <span className={`text-sm font-bold transition-colors ${promptMode === 'prompt' ? 'text-white' : 'text-textSoft'}`}>Tạo Prompt</span>
                                            </label>
                                        </div>
                                        <label className="text-xs font-bold text-textSoft uppercase tracking-wider">Mô tả ý tưởng muốn tạo</label>
                                        <textarea
                                            className="input-style h-[80px] resize-none font-mono text-sm leading-relaxed"
                                            placeholder={promptMode === 'idea' ? "Ví dụ: con mèo lướt sóng..." : "Nhập ý tưởng để AI viết prompt chi tiết cho bạn..."}
                                            value={promptIdea}
                                            onChange={(e) => setPromptIdea(e.target.value)}
                                        />
                                    </div>
                                    <div className="space-y-3 lg:col-span-1">
                                        <label className="text-xs font-bold text-textSoft uppercase tracking-wider">Yêu cầu bổ sung (Dynamic)</label>
                                        <textarea
                                            className="input-style h-[80px] resize-none font-mono text-xs leading-relaxed"
                                            placeholder="Phong cách, nghệ thuật, thông số..."
                                            value={promptDynamic}
                                            onChange={(e) => setPromptDynamic(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-white/5">
                                    <div className="flex gap-4 flex-wrap items-center">
                                        <div className="flex items-center gap-3 shrink-0">
                                            <label className="text-xs font-bold text-textSoft uppercase whitespace-nowrap">Số lượng:</label>
                                            <input
                                                type="number"
                                                className="input-style w-20 py-1.5 px-3 text-sm font-mono"
                                                min={1}
                                                max={100}
                                                value={promptCount}
                                                onChange={(e) => setPromptCount(e.target.value)}
                                            />
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <label className="text-xs font-bold text-textSoft uppercase whitespace-nowrap">Nền tảng AI:</label>
                                            <select
                                                className="input-style w-44 py-1.5 px-3 text-sm"
                                                value={promptPlatform}
                                                onChange={(e) => setPromptPlatform(e.target.value)}
                                            >
                                                <option className="bg-[#1D2130]" value="gpt-4o">OpenAI GPT-4o</option>
                                                <option className="bg-[#1D2130]" value="o4-mini">OpenAI o4-mini</option>
                                                <option className="bg-[#1D2130]" value="gpt-5-nano">GPT-5 Nano</option>
                                                <option className="bg-[#1D2130]" value="gpt-5-mini">GPT-5 Mini</option>
                                                <option className="bg-[#1D2130]" value="gemini">Google Gemini</option>
                                            </select>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <label className="text-xs font-bold text-textSoft uppercase whitespace-nowrap">Nguồn AI:</label>
                                            <div className="flex items-center gap-4">
                                                <label className="flex items-center gap-2 cursor-pointer group text-xs text-textSoft hover:text-white transition-colors">
                                                    <input
                                                        type="radio"
                                                        name="aiSource"
                                                        value="api"
                                                        checked={aiSource === 'api'}
                                                        onChange={() => setAiSource('api')}
                                                        className="sr-only"
                                                    />
                                                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all ${aiSource === 'api'
                                                        ? 'border-accentEnd bg-accentEnd/20 text-accentEnd'
                                                        : 'border-white/20 group-hover:border-white/40'
                                                        }`}>
                                                        {aiSource === 'api' && <div className="w-1.5 h-1.5 rounded-full bg-accentEnd" />}
                                                    </div>
                                                    <span>Dùng API</span>
                                                </label>
                                                <label className="flex items-center gap-2 cursor-pointer group text-xs text-textSoft hover:text-white transition-colors">
                                                    <input
                                                        type="radio"
                                                        name="aiSource"
                                                        value="addon"
                                                        checked={aiSource === 'addon'}
                                                        onChange={() => setAiSource('addon')}
                                                        className="sr-only"
                                                    />
                                                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all ${aiSource === 'addon'
                                                        ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                                                        : 'border-white/20 group-hover:border-white/40'
                                                        }`}>
                                                        {aiSource === 'addon' && <div className="w-1.5 h-1.5 rounded-full bg-purple-500" />}
                                                    </div>
                                                    <span>Dùng Add-on</span>
                                                </label>
                                            </div>
                                        </div>
                                        {aiSource === 'addon' && (
                                            <>
                                                <button
                                                    onClick={handleToggleBridge}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${bridgeRunning
                                                        ? 'bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25'
                                                        : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25'
                                                        }`}
                                                >
                                                    {bridgeRunning ? 'Tắt Bridge' : 'Bật Bridge'}
                                                </button>
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    <div className={`w-2 h-2 rounded-full ${
                                                        extensionConnected
                                                            ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                                                            : bridgeWaiting
                                                                ? 'bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.5)] animate-pulse'
                                                                : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]'
                                                        }`} />
                                                    <span className={`text-xs font-medium ${
                                                        extensionConnected
                                                            ? 'text-emerald-400'
                                                            : bridgeWaiting
                                                                ? 'text-yellow-400'
                                                                : 'text-red-400'
                                                        }`}>
                                                        {extensionConnected
                                                            ? 'Extension kết nối'
                                                            : bridgeWaiting
                                                                ? 'Đang chờ kết nối...'
                                                                : 'Extension ngắt'}
                                                    </span>
                                                </div>
                                            </>
                                        )}
                                    </div>

                                    <div className="flex-1"></div>

                                    <button
                                        onClick={handleGeneratePrompt}
                                        disabled={isGeneratingPrompt}
                                        className={`primary-btn px-6 py-2.5 h-11 ${isGeneratingPrompt ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        {isGeneratingPrompt ? 'Đang tạo...' : 'Tạo Prompts'}
                                        {!isGeneratingPrompt && <Zap size={18} className="fill-white" />}
                                    </button>
                                </div>
                            </div>

                            {/* Bảng kết quả (Ưu tiên chiếm 2/3 không gian) */}
                            <div className="neumorphic-panel p-6 flex-[3] flex flex-col min-h-0 border-white/5 relative overflow-hidden">
                                <div className="flex items-center justify-between mb-4 shrink-0">
                                    <div className="flex items-center gap-3">
                                        <div className="w-1 h-6 bg-accentEnd rounded-full"></div>
                                        <h3 className="text-lg font-bold">Kết quả Prompts ({generatedPrompts.length})</h3>
                                    </div>

                                    {generatedPrompts.length > 0 && (
                                        <div className="flex items-center gap-3">
                                            {promptMode === 'idea' ? (
                                                <div className="flex items-center gap-2">
                                                    <div className="relative group">
                                                        <input
                                                            type="text"
                                                            className="input-style py-1.5 px-3 text-xs w-44 h-9 pr-8"
                                                            placeholder="Tìm/Thêm loại..."
                                                            value={isDropdownOpen ? categorySearch : (categories.find(c => c.id === selectedCategoryId)?.name || "")}
                                                            onFocus={() => setIsDropdownOpen(true)}
                                                            onChange={(e) => {
                                                                setCategorySearch(e.target.value);
                                                                setIsDropdownOpen(true);
                                                            }}
                                                        />
                                                        {selectedCategoryId && (
                                                            <button
                                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-textSoft hover:text-white"
                                                                onClick={() => { setSelectedCategoryId(""); setCategorySearch(""); }}
                                                            >
                                                                ×
                                                            </button>
                                                        )}
                                                        {isDropdownOpen && (
                                                            <div className="absolute top-full left-0 right-0 mt-1 bg-[#1D2130] border border-white/10 rounded-xl shadow-2xl z-[60] max-h-48 overflow-y-auto scrollbar">
                                                                {categories.filter(c => c.name.toLowerCase().includes(categorySearch.toLowerCase())).map(cat => (
                                                                    <div key={cat.id} className="px-3 py-2 text-[11px] hover:bg-white/10 cursor-pointer transition-colors" onClick={() => { setSelectedCategoryId(cat.id); setCategorySearch(""); setIsDropdownOpen(false); }}>{cat.name}</div>
                                                                ))}
                                                                {categorySearch.trim() && !categories.some(c => c.name.toLowerCase() === categorySearch.toLowerCase()) && (
                                                                    <div className="px-3 py-2 text-[11px] border-t border-white/5 text-accentEnd bg-accentStart/10 hover:bg-accentStart/20 cursor-pointer font-bold flex items-center gap-2" onClick={handleCreateCategory}><FolderPlus size={12} /> Thêm: "{categorySearch}"</div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <button onClick={handleBulkCategorize} disabled={selectedIdeaIds.length === 0 || !selectedCategoryId} className="secondary-btn py-1.5 px-3 text-[11px] h-9 gap-1"><FolderPlus size={14} /> Phân loại</button>
                                                </div>
                                            ) : (
                                                <button onClick={handleBulkSavePrompts} disabled={selectedIdeaIds.length === 0} className="secondary-btn py-1.5 px-4 text-[11px] h-9 gap-1"><FolderPlus size={14} /> Thêm vào ý tưởng</button>
                                            )}
                                            <button onClick={handleBulkDelete} disabled={selectedIdeaIds.length === 0} className="tertiary-btn py-1.5 px-3 text-[11px] h-9 gap-1 text-red-400 border-red-500/10"><Trash2 size={14} /> Xóa</button>
                                        </div>
                                    )}
                                </div>

                                <div className="flex-1 overflow-y-auto w-full scrollbar rounded-xl border border-white/5 bg-[#141620]/50 p-4">
                                    {generatedPrompts.length === 0 ? (
                                        <div className="h-full flex items-center justify-center text-textSoft italic text-sm">Chưa có kết quả. Nhập mô tả và nhấn tạo...</div>
                                    ) : (
                                        <table className="w-full text-left font-mono text-sm">
                                            <thead>
                                                <tr className="text-textSoft/50 border-b border-white/10 uppercase text-[10px] tracking-widest">
                                                    <th className="pb-4 w-10 text-center">
                                                        <button onClick={toggleSelectAll} className="hover:text-white">{selectedIdeaIds.length === generatedPrompts.length ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} />}</button>
                                                    </th>
                                                    <th className="pb-4 w-10 text-center">STT</th>
                                                    {promptMode === 'idea' ? (
                                                        <>
                                                            <th className="pb-4 px-4 w-[15%]">Tên Concept</th>
                                                            <th className="pb-4 px-4 w-[25%]">Thể hiện Chủ Thể</th>
                                                            <th className="pb-4 px-4 w-[25%]">Mục Tiêu Thương Mại</th>
                                                            <th className="pb-4 px-4 w-[15%]">Cảm Xúc</th>
                                                            <th className="pb-4 px-4 w-[20%]">Style Cues</th>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <th className="pb-4 px-4 w-48">Tên Ý Tưởng</th>
                                                            <th className="pb-4 px-4">Nội dung Prompt</th>
                                                        </>
                                                    )}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {generatedPrompts.map((p, idx) => (
                                                    <tr key={idx} className={`border-b border-white/5 hover:bg-white/5 transition-colors ${selectedIdeaIds.includes(idx) ? 'bg-white/5' : ''}`}>
                                                        <td className="py-4 text-center align-top" onClick={(e) => { e.stopPropagation(); toggleSelectOne(idx); }}>
                                                            <div className="flex justify-center">{selectedIdeaIds.includes(idx) ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} className="opacity-40" />}</div>
                                                        </td>
                                                        <td className="py-4 text-center text-textSoft align-top text-xs font-bold">{idx + 1}</td>
                                                        {promptMode === 'idea' ? (
                                                            <>
                                                                <td className="py-4 px-4 align-top font-bold text-white leading-tight">{p.title}</td>
                                                                <td className="py-4 px-4 align-top text-xs text-textSoft leading-relaxed">{p.subject_visual}</td>
                                                                <td className="py-4 px-4 align-top text-xs text-textSoft leading-relaxed">{p.commercial_goal}</td>
                                                                <td className="py-4 px-4 align-top text-xs text-textSoft italic leading-relaxed">{p.vibe}</td>
                                                                <td className="py-4 px-4 align-top text-xs text-accentEnd/90 leading-relaxed font-semibold">{p.style_cues}</td>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <td className="py-4 px-4 align-top font-bold text-white leading-tight">{p.name}</td>
                                                                <td className="py-4 px-4 whitespace-pre-wrap text-[13px] leading-relaxed text-white/90">{p.content}</td>
                                                            </>
                                                        )}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'ideas_mgmt' && (() => {
                        const filteredIdeas = ideas
                            .filter(i => {
                                const s = ideaSearch.toLowerCase();
                                return (i.title?.toLowerCase().includes(s) ||
                                    i.commercial_goal?.toLowerCase().includes(s) ||
                                    i.subject_visual?.toLowerCase().includes(s) ||
                                    i.original_keyword?.toLowerCase().includes(s) ||
                                    i.midjourney_prompt?.toString().includes(s));
                            })
                            .filter(i => !ideaFilterCategory || i.category_id === ideaFilterCategory);

                        const totalPages = Math.ceil(filteredIdeas.length / itemsPerPage);
                        const paginatedIdeas = filteredIdeas.slice((ideaPage - 1) * itemsPerPage, ideaPage * itemsPerPage);

                        return (
                            <div className="flex-1 flex flex-col space-y-8 min-h-0">
                                <div className="neumorphic-panel p-6 shrink-0 space-y-3">
                                    <div className="flex items-center gap-3">
                                        <div className="relative" style={{ width: '45%' }}>
                                            <input
                                                type="text"
                                                className="input-style w-full py-3 px-10 text-sm"
                                                placeholder="Tìm kiếm nội dung ý tưởng..."
                                                value={ideaSearch}
                                                onChange={(e) => setIdeaSearch(e.target.value)}
                                            />
                                            <Terminal className="absolute left-3 top-1/2 -translate-y-1/2 text-textSoft" size={18} />
                                        </div>
                                        <select
                                            className="input-style py-3 text-sm"
                                            style={{ width: '45%' }}
                                            value={ideaFilterCategory}
                                            onChange={(e) => setIdeaFilterCategory(e.target.value)}
                                        >
                                            <option value="">Tất cả các loại</option>
                                            {categories.map(cat => (
                                                <option key={cat.id} value={cat.id}>{cat.name}</option>
                                            ))}
                                        </select>
                                        <button onClick={fetchIdeas} className="secondary-btn h-12 px-4 shrink-0" style={{ width: '10%', minWidth: '48px' }} title="Làm mới">
                                            <Zap size={18} className={isLoadingIdeas ? 'animate-spin' : ''} />
                                        </button>
                                    </div>

                                    {selectedManageIdeaIds.length > 0 && (
                                        <div className="flex items-center">
                                            <button
                                                onClick={async () => {
                                                    if (confirm(`Bạn có chắc muốn xóa ${selectedManageIdeaIds.length} ý tưởng đã chọn và toàn bộ prompt liên quan?`)) {
                                                        const { error } = await supabase.from('ideas').delete().in('id', selectedManageIdeaIds);
                                                        if (!error) {
                                                            setIdeas(prev => prev.filter(i => !selectedManageIdeaIds.includes(i.id)));
                                                            setSelectedManageIdeaIds([]);
                                                            addLog(`Đã xóa ${selectedManageIdeaIds.length} ý tưởng`, 'success');
                                                        } else {
                                                            alert("Lỗi khi xóa ý tưởng: " + error.message);
                                                        }
                                                    }
                                                }}
                                                className="secondary-btn h-10 px-5 text-xs bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500 hover:text-white"
                                            >
                                                <Trash2 size={16} />
                                                Xóa {selectedManageIdeaIds.length} mục
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <div className="neumorphic-panel p-8 flex-1 flex flex-col min-h-0">
                                    <div className="flex-1 overflow-y-auto w-full scrollbar rounded-xl border border-white/5 bg-[#141620]/50 p-4">
                                        <table className="w-full text-left font-mono text-sm">
                                            <thead>
                                                <tr className="text-textSoft/50 border-b border-white/10">
                                                    <th className="pb-3 w-12 text-center">
                                                        <button
                                                            onClick={() => {
                                                                if (selectedManageIdeaIds.length === filteredIdeas.length && filteredIdeas.length > 0) {
                                                                    setSelectedManageIdeaIds([]);
                                                                } else {
                                                                    setSelectedManageIdeaIds(filteredIdeas.map(i => i.id));
                                                                }
                                                            }}
                                                            className="p-1 hover:text-white transition-colors"
                                                        >
                                                            {selectedManageIdeaIds.length > 0 && selectedManageIdeaIds.length === filteredIdeas.length ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} />}
                                                        </button>
                                                    </th>
                                                    <th className="pb-3 w-12 text-center">STT</th>
                                                    <th className="pb-3 px-4 w-[10%]">Loại</th>
                                                    <th className="pb-3 px-4 w-[12%]">Tên Concept</th>
                                                    <th className="pb-3 px-4 w-[18%]">Thể hiện Chủ Thể</th>
                                                    <th className="pb-3 px-4 w-[18%]">Mục Tiêu Thương Mại</th>
                                                    <th className="pb-3 px-4 w-[10%]">Cảm Xúc</th>
                                                    <th className="pb-3 px-4 w-[10%]">Style Cues</th>
                                                    <th className="pb-3 px-4 w-[10%]">Từ khóa gốc</th>
                                                    <th className="pb-3 px-4 w-28 text-center">Prompt</th>
                                                    <th className="pb-3 px-4 w-24 text-center">Lệnh</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {paginatedIdeas.length === 0 && !isLoadingIdeas ? (
                                                    <tr>
                                                        <td colSpan="11" className="py-20 text-center text-textSoft italic">
                                                            Không tìm thấy ý tưởng nào trong cơ sở dữ liệu.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    paginatedIdeas.map((idea, idx) => (
                                                        <tr
                                                            key={idea.id}
                                                            onClick={() => {
                                                                setSelectedIdeaForModal(idea);
                                                                fetchIdeaPrompts(idea.id);
                                                                setPromptSortStatus('default');
                                                                setShowPromptsModal(true);
                                                            }}
                                                            className="border-b border-white/5 hover:bg-white/5 group transition-colors cursor-pointer"
                                                        >
                                                            <td className="py-4 px-4 text-center">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (selectedManageIdeaIds.includes(idea.id)) {
                                                                            setSelectedManageIdeaIds(prev => prev.filter(id => id !== idea.id));
                                                                        } else {
                                                                            setSelectedManageIdeaIds(prev => [...prev, idea.id]);
                                                                        }
                                                                    }}
                                                                    className="p-1 hover:text-white transition-colors"
                                                                >
                                                                    {selectedManageIdeaIds.includes(idea.id) ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} className="text-white/20" />}
                                                                </button>
                                                            </td>
                                                            <td className="py-4 text-center text-textSoft font-bold">{(ideaPage - 1) * itemsPerPage + idx + 1}</td>
                                                            <td className="py-4 px-4">
                                                                <span className="px-3 py-1 rounded-lg bg-accentEnd/10 text-accentEnd text-[10px] uppercase font-bold border border-accentEnd/20">
                                                                    {idea.categories?.name || 'Chưa phân loại'}
                                                                </span>
                                                            </td>
                                                            <td className="py-4 px-4 align-top">
                                                                <div className="font-bold text-white mb-1">{idea.title}</div>
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-accentEnd/70 leading-relaxed">
                                                                {idea.subject_visual}
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-textSoft leading-relaxed">
                                                                {idea.commercial_goal}
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-textSoft italic">
                                                                {idea.vibe}
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-textSoft">
                                                                {idea.style_cues}
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-accentEnd/60 italic font-medium">
                                                                {idea.original_keyword}
                                                            </td>
                                                            <td className="py-4 px-4 align-top text-xs text-accentEnd/80 font-mono">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="px-2 py-0.5 rounded bg-accentEnd/10 border border-accentEnd/20 text-accentEnd font-bold">
                                                                        {(idea.prompts || []).filter(p => p.is_used).length}/{(idea.prompts || []).length}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="py-4 px-4 text-center">
                                                                <div className="flex items-center justify-center gap-2">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            const formattedIdea = `Tên concept: ${idea.title}, Thể hiện chủ thể: ${idea.subject_visual}, mục tiêu thương mại: ${idea.commercial_goal}, cảm xúc: ${idea.vibe}, style cues: ${idea.style_cues}`;
                                                                            setPromptIdea(formattedIdea);
                                                                            setActiveIdeaId(idea.id);
                                                                            setActiveOriginalKeyword(idea.original_keyword || "");
                                                                            setPromptMode('prompt');
                                                                            setPromptCount(5);
                                                                            setActiveTab('prompt');
                                                                            addLog("Đã chuyển ý tưởng sang trình tạo Prompt", "success");
                                                                        }}
                                                                        className="p-2 rounded-lg bg-accentEnd/10 text-accentEnd hover:bg-accentEnd hover:text-white transition-all shadow-glow-sm"
                                                                        title="Chuyển sang tạo Prompt"
                                                                    >
                                                                        <Play size={14} />
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (confirm('Bạn có chắc muốn xóa ý tưởng này?')) handleDeleteIdeaFromSupabase(idea.id)
                                                                        }}
                                                                        className="p-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white transition-all"
                                                                        title="Xóa ý tưởng"
                                                                    >
                                                                        <Trash2 size={14} />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Pagination Controls */}
                                    {filteredIdeas.length > 0 && (
                                        <div className="flex items-center justify-between mt-6 px-2 shrink-0">
                                            <div className="text-xs text-textSoft font-medium">
                                                Hiển thị <span className="text-white font-bold">{Math.min(itemsPerPage, filteredIdeas.length - (ideaPage - 1) * itemsPerPage)}</span> trên tổng số <span className="text-white font-bold">{filteredIdeas.length}</span> ý tưởng
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => setIdeaPage(prev => Math.max(1, prev - 1))}
                                                    disabled={ideaPage === 1}
                                                    className={`p-2 rounded-lg bg-white/5 border border-white/10 text-textSoft hover:text-white transition-all ${ideaPage === 1 ? 'opacity-30 cursor-not-allowed' : 'hover:bg-white/10'}`}
                                                >
                                                    <ChevronLeft size={18} />
                                                </button>

                                                <div className="flex items-center gap-1">
                                                    {(() => {
                                                        let pages = [];
                                                        for (let i = 1; i <= totalPages; i++) {
                                                            if (i === 1 || i === totalPages || (i >= ideaPage - 1 && i <= ideaPage + 1)) {
                                                                pages.push(i);
                                                            } else if (i === ideaPage - 2 || i === ideaPage + 2) {
                                                                pages.push("...");
                                                            }
                                                        }
                                                        pages = [...new Set(pages)];

                                                        return pages.map((p, idx) => (
                                                            p === "..." ? (
                                                                <span key={`dots-${idx}`} className="px-2 text-textSoft">...</span>
                                                            ) : (
                                                                <button
                                                                    key={p}
                                                                    onClick={() => setIdeaPage(p)}
                                                                    className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${ideaPage === p ? 'bg-accentEnd text-white shadow-glow-sm' : 'bg-white/5 text-textSoft hover:bg-white/10 hover:text-white border border-white/5'}`}
                                                                >
                                                                    {p}
                                                                </button>
                                                            )
                                                        ));
                                                    })()}
                                                </div>

                                                <button
                                                    onClick={() => setIdeaPage(prev => Math.min(totalPages, prev + 1))}
                                                    disabled={ideaPage >= totalPages}
                                                    className={`p-2 rounded-lg bg-white/5 border border-white/10 text-textSoft hover:text-white transition-all ${ideaPage >= totalPages ? 'opacity-30 cursor-not-allowed' : 'hover:bg-white/10'}`}
                                                >
                                                    <ChevronRight size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Left Column Generator */}
                    {activeTab === 'generator' && (
                        <div className="flex-1 flex flex-col xl:flex-row gap-8 min-h-0 overflow-hidden">
                            {/* Left Column Generator (2/3) */}
                            <div className="flex-1 xl:w-2/3 flex flex-col gap-6 overflow-y-auto pr-2 scrollbar">
                                {/* Neumorphic Card Content */}
                                <div className="neumorphic-panel p-8 space-y-6">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div className="space-y-4">
                                            <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Nền tảng AI sinh ảnh</label>
                                            <select
                                                className="input-style appearance-none font-medium text-lg"
                                                value={config.bot}
                                                onChange={(e) => setConfig({ ...config, bot: e.target.value })}
                                            >
                                                <option className="bg-[#1D2130]" value="midjourney">Midjourney Neural</option>
                                                <option className="bg-[#1D2130]" value="bluewillow">Bluewillow AI</option>
                                                <option className="bg-[#1D2130]" value="grok">Grok (xAI) - Chat</option>
                                                <option className="bg-[#1D2130]" value="grok_imagine">Grok (xAI) - Imagine</option>
                                                <option className="bg-[#1D2130]" value="google_flow">Google Flow</option>
                                            </select>
                                        </div>

                                        {/* Hiển thị Chrome Grok status khi chọn Grok */}
                                        {(config.bot === 'grok' || config.bot === 'grok_imagine') ? (
                                            <div className="space-y-4">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Chrome Grok</label>
                                                <div className="flex items-center justify-between input-style">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-2.5 h-2.5 rounded-full ${grokChromeStatus === 'running' ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
                                                        <span className="text-sm font-medium">
                                                            {grokChromeStatus === 'running' ? 'Đang chạy' : 'Đã tắt'}
                                                        </span>
                                                    </div>
                                                    <button
                                                        id="btn-toggle-grok-chrome"
                                                        onClick={handleToggleGrokChrome}
                                                        disabled={isTogglingChrome}
                                                        className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${grokChromeStatus === 'running'
                                                            ? 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30'
                                                            : 'bg-accentEnd/20 text-accentEnd hover:bg-accentEnd hover:text-white border border-accentEnd/30'
                                                            } ${isTogglingChrome ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                    >
                                                        {isTogglingChrome ? '...' : grokChromeStatus === 'running' ? 'Tắt Chrome' : 'Bật Chrome'}
                                                    </button>
                                                </div>
                                            </div>
                                        ) : config.bot === 'google_flow' ? (
                                            <div className="space-y-4">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Google Flow Bridge</label>
                                                <div className="flex items-center justify-between input-style">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-2.5 h-2.5 rounded-full ${googleFlowChromeStatus === 'running' ? 'bg-green-400 animate-pulse' : googleFlowChromeStatus === 'waiting' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'}`} />
                                                        <span className="text-sm font-medium">{googleFlowChromeStatus === 'running' ? '🟢 Extension đã kết nối' : googleFlowChromeStatus === 'waiting' ? '🟡 Chờ Extension...' : '🔴 Bridge đã tắt'}</span>
                                                    </div>
                                                    <button
                                                        id="btn-toggle-gflow-chrome"
                                                        onClick={handleToggleGoogleFlowChrome}
                                                        disabled={isTogglingGFlowChrome}
                                                        className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
                                                            googleFlowChromeStatus !== 'stopped'
                                                                ? 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30'
                                                                : 'bg-green-500/20 text-green-400 hover:bg-green-500 hover:text-white border border-green-500/30'
                                                        } ${isTogglingGFlowChrome ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                    >
                                                        {isTogglingGFlowChrome ? '...' : googleFlowChromeStatus !== 'stopped' ? 'Tắt Bridge' : 'Bật Bridge'}
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="space-y-4">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Route ID (Guild/Channel)</label>
                                                <input
                                                    className="input-style font-mono text-sm"
                                                    placeholder="Tùy chọn. Bỏ trống nếu là Local DM."
                                                    value={config.channel}
                                                    onChange={(e) => setConfig({ ...config, channel: e.target.value })}
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {/* Grok-specific settings */}
                                    {(config.bot === 'grok' || config.bot === 'grok_imagine') && (
                                        <div className="grid grid-cols-2 gap-6 pt-4 border-t border-white/5">
                                            <div className="space-y-3">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Tỷ lệ ảnh</label>
                                                <select
                                                    id="grok-ratio-select"
                                                    className="input-style appearance-none font-medium"
                                                    value={config.grokRatio || '1:1'}
                                                    onChange={(e) => setConfig({ ...config, grokRatio: e.target.value })}
                                                >
                                                    <option className="bg-[#1D2130]" value="1:1">1:1 (Square)</option>
                                                    <option className="bg-[#1D2130]" value="16:9">16:9 (Landscape)</option>
                                                    <option className="bg-[#1D2130]" value="9:16">9:16 (Portrait)</option>
                                                    <option className="bg-[#1D2130]" value="4:3">4:3 (Standard)</option>
                                                    <option className="bg-[#1D2130]" value="3:2">3:2 (Photo)</option>
                                                    <option className="bg-[#1D2130]" value="auto">Auto</option>
                                                </select>
                                            </div>
                                            <div className="space-y-3">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Số ảnh / Prompt <span className="text-textSoft/50 normal-case font-normal">(tối đa 4)</span></label>
                                                <input
                                                    id="grok-count-input"
                                                    type="number"
                                                    min={1}
                                                    max={4}
                                                    className="input-style font-mono"
                                                    value={config.grokCount || 2}
                                                    onChange={(e) => setConfig({ ...config, grokCount: Math.min(4, Math.max(1, parseInt(e.target.value) || 2)) })}
                                                />
                                            </div>
                                            <div className="col-span-2 space-y-3">
                                                <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Hậu tố Prompt <span className="text-textSoft/50 normal-case font-normal">(thêm vào cuối mỗi prompt)</span></label>
                                                <input
                                                    id="grok-suffix-input"
                                                    type="text"
                                                    className="input-style font-mono text-sm"
                                                    placeholder="Ví dụ: , in photorealistic style, 8k resolution"
                                                    value={config.grokSuffix || ''}
                                                    onChange={(e) => setConfig({ ...config, grokSuffix: e.target.value })}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-4 pt-4 border-t border-white/5">
                                        <div className="flex justify-between items-end">
                                            <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Danh sách Prompt</label>
                                            <div className="flex items-center gap-2">
                                                {(config.bot === 'grok' || config.bot === 'grok_imagine') && (
                                                    <span className="text-xs text-textSoft/60 italic">Không cần --ar, app tự xử lý</span>
                                                )}
                                                <span className="text-xs font-bold text-accentEnd px-3 py-1 rounded-full bg-[#141620] shadow-inner-soft border border-accentEnd/20">
                                                    {promptText.split('\n').filter(p => p.trim() !== '').length} dòng
                                                </span>
                                            </div>
                                        </div>
                                        <textarea
                                            className="input-style h-[240px] resize-none font-mono text-sm leading-relaxed"
                                            placeholder={config.bot === 'grok'
                                                ? '1 prompt mỗi dòng...\nA beautiful sunset over mountains\nCyberpunk city at night...'
                                                : '1 prompt mỗi dòng...\nA cyberpunk cat wearing neon glasses --ar 16:9\nCinematic photo of futuristic Tokyo...'}
                                            value={promptText}
                                            onChange={(e) => setPromptText(e.target.value)}
                                        />
                                    </div>
                                </div>

                                {/* Launch button area */}
                                <div className="flex flex-col gap-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-4">
                                            <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Tiền tố (Prefix)</label>
                                            <input
                                                className="input-style font-mono text-sm"
                                                placeholder="VD: /imagine prompt"
                                                value={config.prefix}
                                                onChange={(e) => setConfig({ ...config, prefix: e.target.value })}
                                            />
                                        </div>
                                        <div className="space-y-4">
                                            <label className="text-sm font-bold text-textSoft tracking-wide font-mono uppercase">Hậu tố (Suffix)</label>
                                            <input
                                                className="input-style font-mono text-sm"
                                                placeholder="VD: --ar 16:9"
                                                value={config.suffix}
                                                onChange={(e) => setConfig({ ...config, suffix: e.target.value })}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex gap-3">
                                        <button
                                            onClick={startGeneration}
                                            disabled={isGenerating}
                                            className={`primary-btn flex-1 h-16 text-lg ${isGenerating ? 'opacity-50 cursor-not-allowed scale-[0.99]' : ''}`}
                                        >
                                            {isGenerating ? 'Đang tạo ảnh...' : 'Bắt đầu Tạo Ảnh'}
                                            {!isGenerating && <Play size={24} className="fill-white" />}
                                        </button>
                                        {isGenerating && (
                                            <button
                                                onClick={stopGeneration}
                                                className="h-16 px-6 rounded-xl font-bold text-white flex items-center gap-2 transition-all duration-200 hover:scale-105"
                                                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 4px 15px rgba(239,68,68,0.4)' }}
                                                title="Dừng tạo ảnh"
                                            >
                                                <X size={24} />
                                                Dừng
                                            </button>
                                        )}
                                    </div>

                                    {isGenerating && (
                                        <div className="neumorphic-card p-4 border border-accentEnd/20 bg-accentEnd/5">
                                            <div className="flex justify-between items-end mb-3">
                                                <span className="text-xs font-bold text-textSoft font-mono uppercase">Tiến độ thực thi</span>
                                                <span className="text-2xl text-[#92C81A] font-black tracking-tighter leading-none" style={{ textShadow: "0 0 10px rgba(146,200,26,0.5)" }}>
                                                    {Math.round(status.percentage)}%
                                                </span>
                                            </div>
                                            <div className="pixel-progress-center">
                                                <div
                                                    className="pixel-progress-main"
                                                    style={{ width: `${status.percentage}%` }}
                                                ></div>
                                                <div className="pixel-progress-row" style={{ width: `calc(100% - ${status.percentage}%)` }}>
                                                    <span className="pixel-progress-sq pixel-sq-1"></span>
                                                    <span className="pixel-progress-sq pixel-sq-2"></span>
                                                    <span className="pixel-progress-sq pixel-sq-3"></span>
                                                </div>
                                                <div className="pixel-progress-row" style={{ width: `calc(100% - ${status.percentage}%)` }}>
                                                    <span className="pixel-progress-sq pixel-sq-4"></span>
                                                    <span className="pixel-progress-sq pixel-sq-5"></span>
                                                    <span className="pixel-progress-sq pixel-sq-6"></span>
                                                </div>
                                                <div className="pixel-progress-row" style={{ width: `calc(100% - ${status.percentage}%)` }}>
                                                    <span className="pixel-progress-sq pixel-sq-7"></span>
                                                    <span className="pixel-progress-sq pixel-sq-8"></span>
                                                    <span className="pixel-progress-sq pixel-sq-9"></span>
                                                </div>
                                                <div className="pixel-progress-row" style={{ width: `calc(100% - ${status.percentage}%)` }}>
                                                    <span className="pixel-progress-sq pixel-sq-10"></span>
                                                    <span className="pixel-progress-sq pixel-sq-11"></span>
                                                    <span className="pixel-progress-sq pixel-sq-12"></span>
                                                </div>
                                            </div>
                                            <div className="flex justify-between mt-3">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-accentEnd animate-pulse" />
                                                    <span className="text-[10px] font-mono text-accentEnd uppercase tracking-widest font-bold">Thời gian ước tính: {status.estimated}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Right Column Terminal (1/3) */}
                            <div className="xl:w-1/3 shrink-0 neumorphic-card flex flex-col p-2 border border-white/5 bg-white/[0.01]">
                                <div className="h-16 flex items-center px-6 justify-between border-b border-white/5 shrink-0 bg-white/[0.02] rounded-t-3xl">
                                    <div className="flex items-center gap-3 text-sm font-black text-white tracking-widest uppercase">
                                        <Terminal size={18} className="text-accentEnd" /> Console Output
                                    </div>
                                    <div className="flex gap-1.5">
                                        <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/40" />
                                        <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/40" />
                                        <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/40" />
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed scrollbar flex flex-col-reverse relative bg-[rgba(10,11,18,0.8)] m-2 rounded-2xl shadow-inner-soft border border-white/[0.03]">
                                    <div className="flex flex-col gap-1 mt-auto">
                                        {logs.map((log, i) => (
                                            <div key={i} className={`flex flex-col min-w-0 py-0.5 border-b border-white/[0.01] last:border-0 ${log.type === 'error' ? 'text-red-400 bg-red-400/5 px-2 rounded' :
                                                log.type === 'success' ? 'text-accentEnd' :
                                                    log.type === 'progress' ? 'text-white' : 'text-textSoft'
                                                }`}>
                                                <div className="flex gap-2">
                                                    <span className="shrink-0 select-none opacity-40 font-bold">[{log.time}]</span>
                                                    <span className="break-words font-medium">{log.msg}</span>
                                                </div>
                                            </div>
                                        ))}
                                        {logs.length === 0 && <div className="text-textSoft/50 italic p-4 text-center">System Idle. Waiting for generation...</div>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'settings' && (
                        <div className="flex-1 space-y-8 max-w-3xl shrink-0">
                            <div className="neumorphic-panel p-8 space-y-8">

                                {/* Auto Update Section */}
                                <div className="flex flex-col pb-6 border-b border-white/5 space-y-4">
                                    <div className="flex justify-between items-center">
                                        <div>
                                            <h3 className="text-xl font-bold flex items-center gap-2">Cập nhật phần mềm {isUpdating && <Sparkles size={16} className="animate-spin text-accentEnd" />}</h3>
                                            <p className="text-sm text-textSoft mt-1">
                                                Phiên bản hiện tại: <span className="text-accentEnd font-mono font-semibold">v1.0.3</span>
                                                {updateInfo && !updateInfo.has_update && <span className="ml-2 text-green-400 text-xs">✓ Đang dùng bản mới nhất</span>}
                                            </p>
                                        </div>
                                        <div className="flex gap-4">
                                            {updateInfo?.has_update ? (
                                                <button
                                                    onClick={handlePerformUpdate}
                                                    disabled={isUpdating}
                                                    className={`secondary-btn px-6 py-2 rounded-xl font-bold bg-accentEnd/20 text-accentEnd border border-accentEnd/30 hover:bg-accentEnd hover:text-white transition-all ${isUpdating ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                >
                                                    {isUpdating ? 'Đang cập nhật...' : `Cài đặt ${updateInfo.version}`}
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={handleCheckUpdate}
                                                    disabled={isCheckingUpdate || isUpdating}
                                                    className={`tertiary-btn px-6 py-2 rounded-xl font-bold ${isCheckingUpdate ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                >
                                                    {isCheckingUpdate ? 'Đang kiểm tra...' : 'Kiểm tra bản mới'}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {updateInfo?.has_update && (
                                        <div className="bg-white/5 rounded-lg border border-white/10 p-4 text-sm font-mono text-white/80 whitespace-pre-wrap max-h-40 overflow-y-auto scrollbar">
                                            <strong className="text-accentEnd block mb-2">Thông tin bản {updateInfo.version}:</strong>
                                            {updateInfo.changelog || 'Không có mô tả cập nhật.'}
                                        </div>
                                    )}
                                </div>

                                <div className="flex items-center justify-between pb-6 border-b border-white/5">
                                    <div>
                                        <h3 className="text-xl font-bold">Đồng bộ phiên Discord</h3>
                                        <p className="text-sm text-textSoft mt-1">Tự động trích xuất Token & JA3 từ Chrome của bạn</p>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        {sessionStatus === 'Connected' ? (
                                            <button
                                                onClick={handleLogout}
                                                className="tertiary-btn px-6 py-2 rounded-xl font-bold border-red-500/30 text-red-400 hover:bg-red-500/10"
                                            >
                                                Huỷ kết nối tài khoản
                                            </button>
                                        ) : (
                                            <button
                                                onClick={handleFetchSession}
                                                disabled={isFetchingSession}
                                                className={`tertiary-btn px-6 py-2 rounded-xl font-bold ${isFetchingSession ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            >
                                                {isFetchingSession ? 'Đang đồng bộ...' : 'Đồng bộ Ngay'}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-4 pb-6 border-b border-white/5">
                                    <h3 className="text-xl font-bold">Cấu hình Supabase</h3>
                                    <p className="text-sm text-textSoft mt-1 mb-4">Kết nối cơ sở dữ liệu và lưu trữ đám mây Supabase</p>

                                    <div className="grid grid-cols-1 gap-6">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                                Project URL
                                            </label>
                                            <input
                                                type="text"
                                                placeholder="https://xxxxxx.supabase.co"
                                                className="input-style font-mono text-sm"
                                                value={config.supabaseUrl || ''}
                                                onChange={e => setConfig({ ...config, supabaseUrl: e.target.value })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                                API Key (anon / public)
                                            </label>
                                            <input
                                                type="password"
                                                placeholder="eyJhbG..."
                                                className="input-style font-mono text-sm"
                                                value={config.supabaseKey || ''}
                                                onChange={e => setConfig({ ...config, supabaseKey: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4 pb-6 border-b border-white/5">
                                    <h3 className="text-xl font-bold">Cấu hình LLM API</h3>
                                    <p className="text-sm text-textSoft mt-1 mb-4">Khoá API để sử dụng tính năng Tạo Prompts AI</p>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                                OpenAI API Key
                                            </label>
                                            <input
                                                type="text"
                                                placeholder="sk-..."
                                                className="input-style font-mono text-sm"
                                                value={config.openaiKey || ''}
                                                onChange={e => setConfig({ ...config, openaiKey: e.target.value })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                                Gemini API Key
                                            </label>
                                            <input
                                                type="text"
                                                placeholder="AIzaSy..."
                                                className="input-style font-mono text-sm"
                                                value={config.geminiKey || ''}
                                                onChange={e => setConfig({ ...config, geminiKey: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4 pb-6 border-b border-white/5">
                                    <h3 className="text-xl font-bold">Cấu hình Google Flow</h3>
                                    <p className="text-sm text-textSoft mt-1 mb-4">URL dự án Google Flow để tạo ảnh</p>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                            Flow Project URL
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="https://flow.google.com/project/... hoặc https://labs.google/fx/tools/flow/project/..."
                                            className="input-style font-mono text-sm"
                                            value={config.googleFlowUrl || ''}
                                            onChange={e => setConfig({ ...config, googleFlowUrl: e.target.value })}
                                        />
                                        <p className="text-xs text-textSoft/50 mt-1">
                                            Hỗ trợ cả hai URL Google Flow:
                                            <br />• <code>https://flow.google.com/project</code> (URL mới)
                                            <br />• <code>https://labs.google/fx/tools/flow/project/xxxxx</code> (URL cũ)
                                        </p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-textSoft flex items-center gap-2">
                                            Delay sau mỗi ảnh (giây)
                                        </label>
                                        <div className="flex items-center gap-3">
                                            <input
                                                type="number"
                                                min="0"
                                                max="300"
                                                id="input-gflow-delay"
                                                className="input-style w-28 text-center"
                                                value={config.googleFlowDelay ?? 10}
                                                onChange={e => setConfig({ ...config, googleFlowDelay: parseInt(e.target.value) || 0 })}
                                            />
                                            <span className="text-sm text-textSoft">giây</span>
                                        </div>
                                        <p className="text-xs text-textSoft/50 mt-1">
                                            Thời gian chờ giữa các prompt. Tăng nếu gặp lỗi hoặc ảnh chưa load kịp.
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between pb-6 border-b border-white/5">
                                    <div>
                                        <h3 className="text-xl font-bold">Tự động Upscale</h3>
                                        <p className="text-sm text-textSoft mt-1">Yêu cầu AI nâng cấp hình ảnh lên độ phân giải tối đa</p>
                                    </div>
                                    <label className="relative cursor-pointer">
                                        <input type="checkbox" className="sr-only" checked={config.upscale} onChange={(e) => setConfig({ ...config, upscale: e.target.checked })} />
                                        <div className={`w-14 h-8 rounded-full shadow-inner-soft transition-colors ${config.upscale ? 'bg-accentStart' : 'bg-[#141620]'}`}></div>
                                        <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition-transform shadow-md ${config.upscale ? 'translate-x-6' : 'translate-x-0'}`}></div>
                                    </label>
                                </div>

                                <div className="flex items-center justify-between pb-6 border-b border-white/5">
                                    <div>
                                        <h3 className="text-xl font-bold">Lưu trữ Tức thì</h3>
                                        <p className="text-sm text-textSoft mt-1">Phần mềm sẽ tự động tải ảnh về máy ngay khi tạo xong</p>
                                    </div>
                                    <label className="relative cursor-pointer">
                                        <input type="checkbox" className="sr-only" checked={config.download} onChange={(e) => setConfig({ ...config, download: e.target.checked })} />
                                        <div className={`w-14 h-8 rounded-full shadow-inner-soft transition-colors ${config.download ? 'bg-accentStart' : 'bg-[#141620]'}`}></div>
                                        <div className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition-transform shadow-md ${config.download ? 'translate-x-6' : 'translate-x-0'}`}></div>
                                    </label>
                                </div>

                                <div className="space-y-4">
                                    <label className="text-sm font-bold text-textSoft tracking-wide flex items-center gap-2">
                                        ID Kênh Discord (Channel ID)
                                        <span className="text-xs font-normal text-textSoft/70">
                                            (Định dạng: ServerID/ChannelID hoặc ChannelID)
                                        </span>
                                    </label>
                                    <input
                                        className="input-style font-mono"
                                        placeholder="Ví dụ: 123456789/987654321"
                                        value={config.channel}
                                        onChange={(e) => setConfig({ ...config, channel: e.target.value })}
                                    />
                                    <p className="text-xs text-textSoft/50 mt-1">
                                        Để trống sẽ tự động gửi qua tin nhắn riêng (DM) với Midjourney Bot.
                                        Nếu gặp lỗi "Unknown Channel" khi dùng DM, hãy điền ID Kênh của một Server.
                                    </p>
                                </div>

                                <div className="space-y-4">
                                    <label className="text-sm font-bold text-textSoft tracking-wide">Tiền tố (Prefix)</label>
                                    <input className="input-style font-mono" placeholder="VD: /imagine prompt" value={config.prefix} onChange={(e) => setConfig({ ...config, prefix: e.target.value })} />
                                </div>

                                <div className="space-y-4">
                                    <label className="text-sm font-bold text-textSoft tracking-wide">Hậu tố toàn cục (Suffix)</label>
                                    <input className="input-style font-mono" placeholder="VD: --ar 16:9" value={config.suffix} onChange={(e) => setConfig({ ...config, suffix: e.target.value })} />
                                </div>

                                <div className="space-y-4">
                                    <label className="text-sm font-bold text-textSoft tracking-wide">Thư mục lưu ảnh</label>
                                    <div className="relative group">
                                        <input
                                            className="input-style font-mono pr-12"
                                            value={config.output}
                                            onChange={(e) => setConfig({ ...config, output: e.target.value })}
                                        />
                                        <button
                                            onClick={handleSelectOutputDir}
                                            disabled={isSelectingDir}
                                            className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-white/5 hover:bg-accentEnd/20 hover:text-accentEnd text-textSoft transition-all ${isSelectingDir ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            title="Chọn thư mục"
                                        >
                                            <Folder size={18} />
                                        </button>
                                    </div>
                                </div>

                                {/* Banned Words Section */}
                                <div className="space-y-4 pt-6 border-t border-white/5">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h3 className="text-xl font-bold flex items-center gap-2">
                                                <span className="text-red-400">⛔</span> Từ cấm (Banned Words)
                                            </h3>
                                            <p className="text-sm text-textSoft mt-1">Các từ sẽ tự động bị thay thế khi tạo ảnh và tạo prompt</p>
                                        </div>
                                        <button
                                            onClick={() => setBannedWords(prev => [...prev, { banned: '', replacement: '' }])}
                                            className="secondary-btn px-4 py-2 text-xs font-bold bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500 hover:text-white transition-all"
                                        >
                                            + Thêm từ cấm
                                        </button>
                                    </div>

                                    {bannedWords.length === 0 ? (
                                        <div className="text-center py-6 bg-white/[0.02] rounded-xl border border-dashed border-white/10">
                                            <p className="text-textSoft/50 text-sm italic">Chưa có từ cấm nào. Nhấn "Thêm từ cấm" để bắt đầu.</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <div className="grid grid-cols-[1fr_20px_1fr_40px] gap-2 items-center px-2 text-[10px] uppercase tracking-widest text-textSoft/40 font-bold">
                                                <span>Từ cấm</span>
                                                <span></span>
                                                <span>Thay thế bằng</span>
                                                <span></span>
                                            </div>
                                            {bannedWords.map((entry, idx) => (
                                                <div key={idx} className="grid grid-cols-[1fr_20px_1fr_40px] gap-2 items-center group">
                                                    <input
                                                        type="text"
                                                        placeholder="Ví dụ: nude"
                                                        className="input-style text-sm font-mono text-red-300 placeholder:text-red-900/40"
                                                        value={entry.banned}
                                                        onChange={e => {
                                                            const updated = [...bannedWords];
                                                            updated[idx] = { ...updated[idx], banned: e.target.value };
                                                            setBannedWords(updated);
                                                        }}
                                                    />
                                                    <span className="text-textSoft/30 text-center text-xs">→</span>
                                                    <input
                                                        type="text"
                                                        placeholder="Ví dụ: artistic"
                                                        className="input-style text-sm font-mono text-green-300 placeholder:text-green-900/40"
                                                        value={entry.replacement}
                                                        onChange={e => {
                                                            const updated = [...bannedWords];
                                                            updated[idx] = { ...updated[idx], replacement: e.target.value };
                                                            setBannedWords(updated);
                                                        }}
                                                    />
                                                    <button
                                                        onClick={() => setBannedWords(prev => prev.filter((_, i) => i !== idx))}
                                                        className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/30 text-red-400 transition-all opacity-0 group-hover:opacity-100"
                                                        title="Xóa"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}


{activeTab === 'gallery' && (
                        <div className="flex-1 flex gap-6 overflow-hidden min-h-0">
                            {galleryFolders.length === 0 ? (
                                <div className="flex-1 neumorphic-panel flex items-center justify-center flex-col gap-6 text-center">
                                    <div className="tertiary-btn w-24 h-24 rounded-full pointer-events-none">
                                        <ImageIcon size={48} className="text-textSoft" />
                                    </div>
                                    <div>
                                        <h3 className="text-2xl font-bold text-white">Thư viện trống</h3>
                                        <p className="text-textSoft mt-2 max-w-sm mx-auto">Chưa có ảnh nào được tạo. Hãy quay lại mục Tạo Ảnh để bắt đầu.</p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {/* Sidebar danh sách thư mục */}
                                    <div className="w-64 neumorphic-panel p-4 flex flex-col shrink-0">
                                        <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-widest pl-2">Lịch sử tạo</h3>
                                        <div className="flex-1 overflow-y-auto pr-2 space-y-2 scrollbar-hide">
                                            {galleryFolders.map((folder) => (
                                                <button
                                                    key={folder.name}
                                                    onClick={() => handleSelectFolder(folder.name)}
                                                    className={`w-full text-left px-4 py-3 rounded-xl transition-all flex items-center gap-3 ${selectedGalleryFolder === folder.name
                                                        ? 'bg-accentEnd/20 text-accentEnd border border-accentEnd/30 shadow-glow-sm'
                                                        : 'bg-white/5 text-textSoft hover:bg-white/10 hover:text-white border border-transparent'
                                                        }`}
                                                >
                                                    <FolderPlus size={16} />
                                                    <span className="font-mono text-sm truncate">{folder.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Grid hiển thị ảnh */}
                                    <div className="flex-1 neumorphic-panel p-6 flex flex-col min-w-0">
                                        <div className="flex items-center justify-between mb-6">
                                            <h3 className="text-lg font-bold text-white">
                                                Album: <span className="text-accentEnd font-mono">{selectedGalleryFolder}</span>
                                            </h3>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <button
                                                    onClick={handleUpscaleFolder}
                                                    disabled={isUpscaling || !selectedGalleryFolder || isExportingExcel}
                                                    className={`secondary-btn py-1.5 px-3 text-[11px] h-8 gap-1.5 bg-accentEnd/10 text-accentEnd border-accentEnd/20 hover:bg-accentEnd hover:text-white ${isUpscaling ? 'opacity-50' : ''}`}
                                                    title="Upscale tất cả ảnh trong album"
                                                >
                                                    <Sparkles size={14} className={isUpscaling ? 'animate-spin' : ''} />
                                                    {isUpscaling ? 'Đang xử lý...' : 'Upscale'}
                                                </button>
                                                <div className="relative">
                                                    <button
                                                        onClick={() => setShowExportMenu(!showExportMenu)}
                                                        disabled={!selectedGalleryFolder || isExportingExcel || isUpscaling}
                                                        className="secondary-btn py-1.5 px-3 text-[11px] h-8 gap-1.5 bg-white/5 border border-white/10 hover:bg-white/10"
                                                        title="Xuất báo cáo & quản lý album"
                                                    >
                                                        <FileText size={14} />
                                                        Xuất Báo Cáo
                                                        <ChevronDown size={12} className={`transform transition-transform duration-200 ${showExportMenu ? 'rotate-180' : ''}`} />
                                                    </button>

                                                    {showExportMenu && (
                                                        <>
                                                            <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                                                            <div className="absolute right-0 mt-2 w-56 rounded-xl bg-[#141824] border border-white/[0.08] shadow-2xl p-1.5 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                                                                {/* Excel Section */}
                                                                <div className="px-2 py-1 text-[10px] font-semibold text-textSoft/60 uppercase tracking-wider">Excel</div>
                                                                <button
                                                                    onClick={() => handleExportWithKeywords('excel', 'api')}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/5 flex items-center gap-2 text-textSoft hover:text-white transition-all"
                                                                >
                                                                    <FileSpreadsheet size={13} className="text-emerald-400" />
                                                                    <span>Xuất Excel</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">API</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => handleExportWithKeywords('excel', 'addon')}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/5 flex items-center gap-2 text-textSoft hover:text-white transition-all"
                                                                >
                                                                    <FileSpreadsheet size={13} className="text-emerald-400" />
                                                                    <span>Xuất Excel</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium">Addon</span>
                                                                </button>

                                                                {/* Fix Title Section */}
                                                                <button
                                                                    onClick={async () => {
                                                                        setShowExportMenu(false);
                                                                        if (!selectedGalleryFolder) return;
                                                                        addLog(`Đang fix title Excel cho album: ${selectedGalleryFolder}...`, 'info');
                                                                        try {
                                                                            const res = await FixExcelTitles(config.output, selectedGalleryFolder, config.prefix);
                                                                            if (res.startsWith('Success:')) {
                                                                                const detail = res.substring('Success: '.length);
                                                                                addLog(`✓ Fix title xong: ${detail}`, 'success');
                                                                                alert(`Fix title Excel thành công!\n${detail}`);
                                                                            } else {
                                                                                addLog(`Lỗi fix title: ${res}`, 'error');
                                                                                alert('Lỗi: ' + res);
                                                                            }
                                                                        } catch (e) {
                                                                            addLog(`Lỗi fix title: ${e.message}`, 'error');
                                                                            alert('Lỗi: ' + e.message);
                                                                        }
                                                                    }}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-amber-500/10 flex items-center gap-2 text-amber-400 hover:text-amber-300 transition-all"
                                                                >
                                                                    <Sparkles size={13} className="text-amber-400" />
                                                                    <span>Fix Title Excel</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium">CLEAN</span>
                                                                </button>

                                                                <button
                                                                    onClick={async () => {
                                                                        setShowExportMenu(false);
                                                                        if (!selectedGalleryFolder) return;
                                                                        addLog(`Đang fix data.json cho album: ${selectedGalleryFolder}...`, 'info');
                                                                        try {
                                                                            const res = await FixAlbumData(config.output, selectedGalleryFolder);
                                                                            if (res.startsWith('Success:')) {
                                                                                addLog(res, 'success');
                                                                                alert(res);
                                                                            } else {
                                                                                addLog(res, 'error');
                                                                                alert(res);
                                                                            }
                                                                        } catch (e) {
                                                                            addLog(`Lỗi fix data.json: ${e.message}`, 'error');
                                                                            alert('Lỗi: ' + e.message);
                                                                        }
                                                                    }}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-cyan-500/10 flex items-center gap-2 text-cyan-400 hover:text-cyan-300 transition-all"
                                                                >
                                                                    <FileText size={13} className="text-cyan-400" />
                                                                    <span>Fix data.json</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-medium">IMAGES</span>
                                                                </button>

                                                                <div className="h-[1px] bg-white/[0.08] my-1" />

                                                                {/* CSV Section */}
                                                                <div className="px-2 py-1 text-[10px] font-semibold text-textSoft/60 uppercase tracking-wider">CSV</div>
                                                                <button
                                                                    onClick={() => handleExportWithKeywords('csv', 'api')}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/5 flex items-center gap-2 text-textSoft hover:text-white transition-all"
                                                                >
                                                                    <FileText size={13} className="text-blue-400" />
                                                                    <span>Xuất CSV</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">API</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => handleExportWithKeywords('csv', 'addon')}
                                                                    disabled={isExportingExcel || isUpscaling}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/5 flex items-center gap-2 text-textSoft hover:text-white transition-all"
                                                                >
                                                                    <FileText size={13} className="text-blue-400" />
                                                                    <span>Xuất CSV</span>
                                                                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium">Addon</span>
                                                                </button>
                                                                <button
                                                                    onClick={async () => {
                                                                        setShowExportMenu(false);
                                                                        if (!selectedGalleryFolder) return;
                                                                        addLog(`Đang xuất CSV (không keywords) cho album: ${selectedGalleryFolder}...`, 'info');
                                                                        try {
                                                                            const res = await ExportCSV(config.output, selectedGalleryFolder);
                                                                            if (res.startsWith("Success:")) {
                                                                                const filePath = res.split(': ')[1];
                                                                                addLog(`Đã xuất CSV thành công: ${filePath}`, 'success');
                                                                                alert(`Đã xuất CSV thành công!\nĐường dẫn: ${filePath}`);
                                                                            } else {
                                                                                addLog(`Lỗi xuất CSV: ${res}`, 'error');
                                                                                alert("Lỗi: " + res);
                                                                            }
                                                                        } catch (e) {
                                                                            addLog(`Lỗi xuất CSV: ${e.message}`, 'error');
                                                                        }
                                                                    }}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/5 flex items-center gap-2 text-textSoft hover:text-white transition-all"
                                                                >
                                                                    <FileText size={13} className="text-gray-400" />
                                                                    <span>Xuất CSV (không keywords)</span>
                                                                </button>

                                                                <div className="h-[1px] bg-white/[0.08] my-1" />
                                                                <button
                                                                    onClick={async () => {
                                                                        setShowExportMenu(false);
                                                                        if (!selectedGalleryFolder) return;
                                                                        if (!confirm(`Bạn có chắc muốn XÓA album "${selectedGalleryFolder}"?\nHành động này không thể hoàn tác!`)) return;
                                                                        try {
                                                                            const res = await DeleteAlbum(config.output, selectedGalleryFolder);
                                                                            if (res.startsWith("Success:")) {
                                                                                addLog(`Đã xóa album: ${selectedGalleryFolder}`, 'success');
                                                                                const folders = await GetGalleryFolders(config.output);
                                                                                setGalleryFolders(folders || []);
                                                                                setSelectedGalleryFolder('');
                                                                                setGalleryImages([]);
                                                                            } else {
                                                                                addLog(`Lỗi xóa album: ${res}`, 'error');
                                                                                alert("Lỗi: " + res);
                                                                            }
                                                                        } catch (e) {
                                                                            addLog(`Lỗi xóa album: ${e.message}`, 'error');
                                                                        }
                                                                    }}
                                                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-red-500/10 text-red-400 hover:text-red-300 flex items-center gap-2 transition-all"
                                                                >
                                                                    <Trash2 size={13} />
                                                                    <span>Xóa Album</span>
                                                                </button>
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => setIsSelectingImages(true)}
                                                    disabled={!selectedGalleryFolder || galleryImages.length === 0}
                                                    className="secondary-btn py-1.5 px-3 text-[11px] h-8 gap-1.5 bg-purple-500/10 text-purple-300 border-purple-500/20 hover:bg-purple-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                                    title="Chọn ảnh để xóa"
                                                >
                                                    <CheckSquare size={14} />
                                                    Chọn Ảnh
                                                </button>
                                                <span className="text-sm text-textSoft px-3 py-1 bg-white/5 rounded-full border border-white/10">
                                                    {galleryTotal} ảnh
                                                </span>
                                            </div>
                                        </div>

                                        {isSelectingImages && (
                                            <div className="flex items-center justify-between bg-purple-500/10 border border-purple-500/20 rounded-xl p-3 mb-4 animate-in slide-in-from-top-1 duration-200">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xs text-purple-300 font-medium">
                                                        Đang chọn: <strong className="text-white text-sm">{selectedImageNames.length}</strong> / {galleryTotal} ảnh
                                                    </span>
                                                    <button
                                                        onClick={handleSelectAllImages}
                                                        className="px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-white text-[11px] font-medium transition-all"
                                                    >
                                                        {selectedImageNames.length === galleryImages.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                                                    </button>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={handleDeleteSelectedImages}
                                                        disabled={selectedImageNames.length === 0}
                                                        className="px-3 py-1 rounded bg-red-500 hover:bg-red-600 text-white text-[11px] font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                                                    >
                                                        <Trash2 size={11} />
                                                        Xóa ảnh đã chọn
                                                    </button>
                                                    <button
                                                        onClick={handleCancelSelection}
                                                        className="px-3 py-1 rounded bg-white/10 hover:bg-white/15 text-white text-[11px] font-medium transition-all"
                                                    >
                                                        Hủy
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex-1 overflow-y-auto pr-2 scrollbar">
                                            {galleryImages.length === 0 && !isLoadingGallery ? (
                                                <div className="flex flex-col items-center justify-center h-full text-textSoft">
                                                    <ImageIcon size={32} className="opacity-50 mb-3" />
                                                    <p>Không có ảnh Thumb nào trong thư mục này.</p>
                                                </div>
                                            ) : (
                                                <div className="flex flex-wrap gap-4 justify-start">
                                                    {galleryImages.map((img, idx) => {
                                                        const isSelected = selectedImageNames.includes(img.name);
                                                        // Find the real index in the full galleryImageNames list
                                                        const globalIdx = galleryImageNames.findIndex(n => n.name === img.name);
                                                        return (
                                                            <div
                                                                key={img.name}
                                                                onClick={async () => {
                                                                    if (isSelectingImages) {
                                                                        if (isSelected) {
                                                                            setSelectedImageNames(prev => prev.filter(name => name !== img.name));
                                                                        } else {
                                                                            setSelectedImageNames(prev => [...prev, img.name]);
                                                                        }
                                                                    } else {
                                                                        setIsLoadingFullImage(true);
                                                                        try {
                                                                            const fullB64 = await GetImageFullBase64(config.output, selectedGalleryFolder, img.name);
                                                                            if (fullB64) {
                                                                                setPreviewImage({ name: img.name, base64: fullB64 });
                                                                                setCurrentPreviewIndex(globalIdx >= 0 ? globalIdx : idx);
                                                                            }
                                                                        } catch (e) {
                                                                            console.error("Lỗi khi tải ảnh gốc:", e);
                                                                        } finally {
                                                                            setIsLoadingFullImage(false);
                                                                        }
                                                                    }
                                                                }}
                                                                className={`w-[182px] h-[102px] rounded-xl bg-white/5 border overflow-hidden group relative shrink-0 shadow-glow-sm active:scale-95 transition-all ${isSelected
                                                                    ? 'border-purple-500 ring-2 ring-purple-500/50'
                                                                    : 'border-white/10 hover:border-white/20'
                                                                    } ${isSelectingImages ? 'cursor-pointer' : 'cursor-zoom-in'}`}
                                                            >
                                                                {isSelectingImages && (
                                                                    <div className={`absolute top-2 right-2 z-10 w-5 h-5 rounded flex items-center justify-center border transition-all ${isSelected
                                                                        ? 'bg-purple-500 border-purple-500 text-white'
                                                                        : 'bg-black/50 border-white/40 text-transparent'
                                                                        }`}>
                                                                        <CheckSquare size={12} className={isSelected ? '' : 'hidden'} />
                                                                    </div>
                                                                )}
                                                                <img
                                                                    src={img.base64}
                                                                    alt={img.name}
                                                                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                                                    loading="lazy"
                                                                />
                                                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2 flex flex-col justify-end">
                                                                    <p className="text-[9px] text-white font-mono break-all line-clamp-2 leading-tight">
                                                                        {img.name}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}

                                            {/* Load More button */}
                                            {galleryPage < galleryTotalPages && (
                                                <div className="flex justify-center mt-6 mb-2">
                                                    <button
                                                        onClick={handleLoadMoreGallery}
                                                        disabled={isLoadingGallery}
                                                        className={`px-8 py-2.5 rounded-xl font-bold text-sm transition-all border ${isLoadingGallery
                                                            ? 'bg-white/5 text-textSoft border-white/5 cursor-wait'
                                                            : 'bg-accentEnd/10 text-accentEnd border-accentEnd/20 hover:bg-accentEnd hover:text-white shadow-glow-sm'
                                                            }`}
                                                    >
                                                        {isLoadingGallery ? (
                                                            <span className="flex items-center gap-2">
                                                                <div className="w-4 h-4 border-2 border-textSoft/30 border-t-accentEnd rounded-full animate-spin" />
                                                                Đang tải...
                                                            </span>
                                                        ) : (
                                                            `Tải thêm (${galleryImages.length}/${galleryTotal})`
                                                        )}
                                                    </button>
                                                </div>
                                            )}

                                            {/* Loading spinner for initial load */}
                                            {isLoadingGallery && galleryImages.length === 0 && (
                                                <div className="flex flex-col items-center justify-center h-full text-textSoft gap-3">
                                                    <div className="w-10 h-10 border-3 border-white/10 border-t-accentEnd rounded-full animate-spin" />
                                                    <p className="text-sm">Đang tải thumbnail...</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Popup xem ảnh lớn */}
                {previewImage && (
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 backdrop-blur-md p-4 animate-in fade-in duration-300"
                        onClick={() => { setPreviewImage(null); setCurrentPreviewIndex(-1); }}
                    >
                        {/* Nút thoát */}
                        <div className="absolute top-6 right-6 flex items-center gap-3 z-10">
                            <button
                                className={`p-3 rounded-full bg-accentEnd/10 hover:bg-accentEnd text-accentEnd hover:text-white transition-all shadow-glow-sm border border-accentEnd/20 ${isUpscaling ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={(e) => { e.stopPropagation(); handleUpscaleImage(); }}
                                disabled={isUpscaling}
                                title="Phóng to x4 (Upscale)"
                            >
                                <Sparkles size={24} className={isUpscaling ? "animate-spin" : ""} />
                            </button>
                            <button
                                className="p-3 rounded-full bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white transition-all shadow-glow-sm border border-red-500/20"
                                onClick={(e) => { e.stopPropagation(); handleDeleteImage(); }}
                                title="Xóa ảnh (Delete)"
                            >
                                <Trash2 size={24} />
                            </button>
                            <button
                                className="p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all shadow-glow-sm border border-white/10"
                                onClick={() => { setPreviewImage(null); setCurrentPreviewIndex(-1); }}
                                title="Đóng (Esc)"
                            >
                                <X size={24} />
                            </button>
                        </div>

                        {/* Nút Previous */}
                        <button
                            className="absolute left-6 top-1/2 -translate-y-1/2 p-5 rounded-full bg-white/5 hover:bg-accentEnd/20 text-white/50 hover:text-accentEnd transition-all z-10 border border-white/5 hover:border-accentEnd/50 shadow-2xl group active:scale-90"
                            onClick={(e) => { e.stopPropagation(); handleNavigateImage(-1); }}
                        >
                            <ChevronLeft size={40} className="group-hover:-translate-x-1 transition-transform" />
                        </button>

                        {/* Nút Next */}
                        <button
                            className="absolute right-6 top-1/2 -translate-y-1/2 p-5 rounded-full bg-white/5 hover:bg-accentEnd/20 text-white/50 hover:text-accentEnd transition-all z-10 border border-white/5 hover:border-accentEnd/50 shadow-2xl group active:scale-90"
                            onClick={(e) => { e.stopPropagation(); handleNavigateImage(1); }}
                        >
                            <ChevronRight size={40} className="group-hover:translate-x-1 transition-transform" />
                        </button>

                        <div
                            className="relative max-w-full max-h-full flex flex-col items-center gap-6"
                            onClick={e => e.stopPropagation()}
                        >
                            <div className="neumorphic-panel p-2.5 bg-white/5 border border-white/10 rounded-2xl shadow-2xl overflow-hidden relative group">
                                <img
                                    src={previewImage.base64}
                                    alt={previewImage.name}
                                    className="max-w-[85vw] max-h-[82vh] object-contain rounded-xl shadow-glow select-none pointer-events-none"
                                />
                                <div className="absolute top-4 left-4 flex gap-2">
                                    <div className="bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 text-[10px] text-accentEnd font-bold uppercase tracking-widest">
                                        Full Resolution
                                    </div>
                                </div>
                            </div>
                            <div className="bg-black/60 backdrop-blur-lg px-6 py-3 rounded-full border border-white/10 flex items-center gap-6 shadow-2xl">
                                <p className="text-white font-mono text-sm font-semibold tracking-tight">{previewImage.name}</p>
                                <div className="h-4 w-px bg-white/20" />
                                <span className="text-accentEnd font-black font-mono text-sm min-w-[60px] text-center">
                                    {(currentPreviewIndex + 1).toString().padStart(2, '0')} / {galleryImageNames.length.toString().padStart(2, '0')}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Overlay Loading khi tải ảnh lớn */}
                {(isLoadingFullImage || isUpscaling) && (
                    <div className="fixed inset-0 z-[201] flex items-center justify-center bg-black/60 backdrop-blur-md">
                        <div className="flex flex-col items-center gap-6 max-w-md w-full px-8">
                            <div className="w-16 h-16 border-4 border-accentEnd/20 border-t-accentEnd rounded-full animate-spin shadow-glow-sm" />

                            <div className="text-center space-y-2 w-full">
                                <p className="text-white font-bold tracking-widest text-sm uppercase animate-pulse">
                                    {isUpscaling ? 'Đang thực hiện Upscale x4...' : 'Đang tải ảnh gốc...'}
                                </p>

                                {isUpscaling && upscaleProgress && (
                                    <>
                                        <div className="w-full bg-white/10 rounded-full h-2 mt-4 overflow-hidden border border-white/5">
                                            <div
                                                className="bg-accentEnd h-full transition-all duration-500 shadow-glow-sm"
                                                style={{ width: `${(upscaleProgress.current / upscaleProgress.total) * 100}%` }}
                                            />
                                        </div>
                                        <div className="flex justify-between text-[10px] text-textSoft font-mono mt-1">
                                            <span>{upscaleProgress.file}</span>
                                            <span className="text-accentEnd">{upscaleProgress.current} / {upscaleProgress.total}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
            {/* Modal hiển thị danh sách Prompt của ý tưởng */}
            {
                showPromptsModal && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="neumorphic-panel w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border border-white/10">
                            {/* Header của Modal */}
                            <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                                <div className="flex items-center gap-6">
                                    <div>
                                        <h3 className="text-xl font-bold text-white flex items-center gap-3">
                                            <div className="w-2 h-8 bg-accentEnd rounded-full" />
                                            Bảng Quản lý Prompt Chi tiết
                                        </h3>
                                        <p className="text-sm text-textSoft mt-1">Concept: <span className="text-accentEnd italic">{selectedIdeaForModal?.title}</span></p>
                                    </div>

                                    {selectedModalPromptIds.length > 0 && (
                                        <div className="flex items-center gap-3 animate-in fade-in slide-in-from-left-4">
                                            <span className="text-xs text-textSoft/50 px-3 py-1 bg-white/5 rounded-full border border-white/10">
                                                Đã chọn <span className="text-white font-bold">{selectedModalPromptIds.length}</span>
                                            </span>
                                            <button
                                                onClick={async () => {
                                                    if (confirm(`Bạn có chắc muốn xóa ${selectedModalPromptIds.length} prompt đã chọn?`)) {
                                                        // 1. Xóa khỏi bảng prompts
                                                        const { error } = await supabase.from('prompts').delete().in('id', selectedModalPromptIds);
                                                        if (!error) {
                                                            // 2. Cập nhật mảng trong bảng ideas để đồng bộ hóa
                                                            const { data: ideaData } = await supabase.from('ideas').select('midjourney_prompt').eq('id', selectedIdeaForModal.id).single();
                                                            if (ideaData) {
                                                                const filteredArray = (ideaData.midjourney_prompt || []).filter(id => !selectedModalPromptIds.includes(id));
                                                                await supabase.from('ideas').update({ midjourney_prompt: filteredArray }).eq('id', selectedIdeaForModal.id);
                                                            }

                                                            setModalPrompts(prev => prev.filter(p => !selectedModalPromptIds.includes(p.id)));
                                                            setSelectedModalPromptIds([]);
                                                            fetchIdeas();
                                                            addLog(`Đã xóa ${selectedModalPromptIds.length} prompt`, 'success');
                                                        }
                                                    }
                                                }}
                                                className="secondary-btn h-9 px-4 text-xs bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white border-red-500/20"
                                            >
                                                <Trash2 size={14} />
                                                Xóa hàng loạt
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const selectedPromptsStr = modalPrompts
                                                        .filter(p => selectedModalPromptIds.includes(p.id))
                                                        .map(p => p.content)
                                                        .join('\n');
                                                    if (selectedPromptsStr) {
                                                        setPromptText(prev => {
                                                            const newVal = prev ? prev + '\n' + selectedPromptsStr : selectedPromptsStr;
                                                            localStorage.setItem('bulkai_prompts', newVal);
                                                            return newVal;
                                                        });
                                                        setShowPromptsModal(false);
                                                        setSelectedModalPromptIds([]);
                                                        setActiveTab('generator');
                                                        addLog(`Đã chuyển ${selectedModalPromptIds.length} prompt sang form tạo ảnh`, 'success');
                                                    }
                                                }}
                                                className="secondary-btn h-9 px-4 text-xs bg-accentEnd/10 text-accentEnd hover:bg-accentEnd hover:text-white border-accentEnd/20 transition-all font-bold"
                                            >
                                                <ImageIcon size={14} />
                                                Gửi sang Form tạo ảnh
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => {
                                        setShowPromptsModal(false);
                                        setSelectedModalPromptIds([]);
                                    }}
                                    className="p-2 rounded-full hover:bg-white/10 text-textSoft hover:text-white transition-all"
                                >
                                    <X size={24} />
                                </button>
                            </div>

                            {/* Nội dung Modal */}
                            <div className="p-6 flex-1 overflow-y-auto scrollbar bg-[#0f111a]">
                                {isLoadingModalPrompts ? (
                                    <div className="flex flex-col items-center justify-center py-20 gap-4 text-textSoft">
                                        <Zap size={40} className="animate-spin text-accentEnd" />
                                        <p className="animate-pulse">Đang nạp dữ liệu prompt...</p>
                                    </div>
                                ) : modalPrompts.length === 0 ? (
                                    <div className="text-center py-20 bg-white/[0.02] rounded-2xl border border-dashed border-white/10">
                                        <p className="text-textSoft italic">Ý tưởng này chưa có prompt nào được lưu.</p>
                                        <button
                                            onClick={() => {
                                                setShowPromptsModal(false);
                                                const formattedIdea = `Tên concept: ${selectedIdeaForModal.title}, mục tiêu thương mại: ${selectedIdeaForModal.commercial_goal}, cảm xúc: ${selectedIdeaForModal.vibe}, style cues: ${selectedIdeaForModal.style_cues}`;
                                                setPromptIdea(formattedIdea);
                                                setActiveIdeaId(selectedIdeaForModal.id);
                                                setPromptMode('prompt');
                                                setActiveTab('prompt');
                                            }}
                                            className="mt-4 text-accentEnd text-sm hover:underline"
                                        >
                                            Tạo prompt ngay →
                                        </button>
                                    </div>
                                ) : (
                                    <div className="rounded-xl border border-white/5 overflow-hidden shadow-glow-sm">
                                        <table className="w-full text-left font-mono text-xs">
                                            <thead>
                                                <tr className="bg-white/[0.03] text-textSoft/50 uppercase tracking-widest border-b border-white/5">
                                                    <th className="py-4 px-4 w-12 text-center">
                                                        <button
                                                            onClick={() => {
                                                                if (selectedModalPromptIds.length === modalPrompts.length) {
                                                                    setSelectedModalPromptIds([]);
                                                                } else {
                                                                    setSelectedModalPromptIds(modalPrompts.map(p => p.id));
                                                                }
                                                            }}
                                                            className="p-1 hover:text-white transition-colors"
                                                        >
                                                            {selectedModalPromptIds.length > 0 && selectedModalPromptIds.length === modalPrompts.length ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} />}
                                                        </button>
                                                    </th>
                                                    <th className="py-4 px-4 w-12 text-center">STT</th>
                                                    <th className="py-4 px-4 w-40">Tên Prompt</th>
                                                    <th className="py-4 px-4">Nội dung Prompt</th>
                                                    <th className="py-4 px-4 w-32 text-center">
                                                        <button
                                                            onClick={() => {
                                                                setPromptSortStatus(prev => {
                                                                    if (prev === 'default') return 'unused_first';
                                                                    if (prev === 'unused_first') return 'used_first';
                                                                    return 'default';
                                                                });
                                                            }}
                                                            className="flex items-center gap-1 mx-auto hover:text-accentEnd transition-colors group"
                                                            title="Nhấn để sắp xếp theo trạng thái"
                                                        >
                                                            Trạng thái
                                                            <span className={`text-[8px] transition-colors ${promptSortStatus !== 'default' ? 'text-accentEnd' : 'text-textSoft/30 group-hover:text-textSoft/60'}`}>
                                                                {promptSortStatus === 'unused_first' ? '▲' : promptSortStatus === 'used_first' ? '▼' : '◆'}
                                                            </span>
                                                        </button>
                                                    </th>
                                                    <th className="py-4 px-4 w-32 text-center">Ngày tạo</th>
                                                    <th className="py-4 px-4 w-28 text-center">Hành động</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {[...modalPrompts].sort((a, b) => {
                                                    if (promptSortStatus === 'unused_first') return (a.is_used === b.is_used) ? 0 : a.is_used ? 1 : -1;
                                                    if (promptSortStatus === 'used_first') return (a.is_used === b.is_used) ? 0 : a.is_used ? -1 : 1;
                                                    return 0;
                                                }).map((p, pIdx) => (
                                                    <tr key={p.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group">
                                                        <td className="py-4 px-4 text-center">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (selectedModalPromptIds.includes(p.id)) {
                                                                        setSelectedModalPromptIds(prev => prev.filter(uid => uid !== p.id));
                                                                    } else {
                                                                        setSelectedModalPromptIds(prev => [...prev, p.id]);
                                                                    }
                                                                }}
                                                                className="p-1 hover:text-white transition-colors"
                                                            >
                                                                {selectedModalPromptIds.includes(p.id) ? <CheckSquare size={16} className="text-accentEnd" /> : <Square size={16} className="text-white/20" />}
                                                            </button>
                                                        </td>
                                                        <td className="py-4 px-4 text-center text-textSoft/60">{modalPrompts.length - pIdx}</td>
                                                        <td className="py-4 px-4 text-white font-bold text-xs">{p.title || "---"}</td>
                                                        <td className="py-4 px-4">
                                                            <div className="text-white/80 line-clamp-2 leading-relaxed" title={p.content}>
                                                                {p.content}
                                                            </div>
                                                        </td>
                                                        <td className="py-4 px-4 text-center">
                                                            <button
                                                                onClick={async (e) => {
                                                                    e.stopPropagation();
                                                                    const { error } = await supabase.from('prompts').update({ is_used: !p.is_used }).eq('id', p.id);
                                                                    if (!error) {
                                                                        setModalPrompts(prev => prev.map(item => item.id === p.id ? { ...item, is_used: !p.is_used } : item));
                                                                    }
                                                                }}
                                                                className={`px-3 py-1 rounded-full text-[9px] font-bold uppercase transition-all tracking-tighter ${p.is_used
                                                                    ? 'bg-accentEnd/20 text-accentEnd border border-accentEnd/30'
                                                                    : 'bg-white/5 text-textSoft/50 border border-white/10 hover:border-white/20'
                                                                    }`}
                                                            >
                                                                {p.is_used ? 'Đã dùng' : 'Chưa dùng'}
                                                            </button>
                                                        </td>
                                                        <td className="py-4 px-4 text-center text-textSoft/40 italic">
                                                            {new Date(p.created_at).toLocaleDateString('vi-VN')}
                                                        </td>
                                                        <td className="py-4 px-4">
                                                            <div className="flex items-center justify-center gap-2">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        navigator.clipboard.writeText(p.content);
                                                                        addLog("Đã sao chép prompt", "success");
                                                                    }}
                                                                    className="p-1.5 rounded-lg bg-white/5 hover:bg-accentEnd/20 hover:text-accentEnd text-textSoft transition-all"
                                                                    title="Sao chép"
                                                                >
                                                                    <Copy size={12} />
                                                                </button>
                                                                <button
                                                                    onClick={async (e) => {
                                                                        e.stopPropagation();
                                                                        if (confirm('Xóa prompt này?')) {
                                                                            const { error } = await supabase.from('prompts').delete().eq('id', p.id);
                                                                            if (!error) {
                                                                                const { data: ideaData } = await supabase.from('ideas').select('midjourney_prompt').eq('id', selectedIdeaForModal.id).single();
                                                                                if (ideaData) {
                                                                                    const filteredArray = (ideaData.midjourney_prompt || []).filter(id => id !== p.id);
                                                                                    await supabase.from('ideas').update({ midjourney_prompt: filteredArray }).eq('id', selectedIdeaForModal.id);
                                                                                }
                                                                                setModalPrompts(prev => prev.filter(item => item.id !== p.id));
                                                                                fetchIdeas();
                                                                            }
                                                                        }
                                                                    }}
                                                                    className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all"
                                                                    title="Xóa"
                                                                >
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            {/* Footer của Modal */}
                            <div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-end">
                                <button
                                    onClick={() => {
                                        setShowPromptsModal(false);
                                        setSelectedModalPromptIds([]);
                                    }}
                                    className="px-6 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white text-sm font-bold transition-all"
                                >
                                    Đóng
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
}

export default App;
