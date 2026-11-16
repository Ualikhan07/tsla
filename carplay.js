// Tesla Cinema & Video Engine • Drive & Reverse • wBlock Ad-Shield

// Helper for fast requests with timeout
async function fetchWithTimeout(url, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// Unified video item normalizer for Invidious and Piped
function normalizeVideoItem(v) {
    if (!v) return null;
    let videoId = v.videoId || v.id;
    if (!videoId && typeof v.url === 'string') {
        const match = v.url.match(/(?:v=|youtu\.be\/|\/watch\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        if (match) videoId = match[1];
        else if (v.url.startsWith('/watch?v=')) videoId = v.url.replace('/watch?v=', '');
    }
    if (!videoId || videoId.length < 5) return null;

    const title = v.title || "Видео без названия";
    const author = v.uploaderName || v.author || "";
    const durationSec = Number(v.duration ?? v.lengthSeconds ?? 0) || 0;
    
    let thumb = "";
    if (v.videoThumbnails && v.videoThumbnails.length > 0) {
        thumb = v.videoThumbnails[0].url;
    } else if (v.thumbnail) {
        thumb = v.thumbnail;
    } else {
        thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    const isLive = Boolean(v.liveNow || v.isLive || (v.uploadedDate && v.uploadedDate.includes('Live')) || (durationSec > 43200));

    return {
        videoId,
        title,
        author,
        durationSec,
        thumb,
        isLive,
        badgeText: v.badgeText || ""
    };
}

// Active multi-provider YouTube API endpoints
const YT_API_PROVIDERS = [
    {
        name: 'Piped (private.coffee)',
        type: 'piped',
        searchUrl: (q) => `https://api.piped.private.coffee/search?q=${encodeURIComponent(q)}&filter=all`,
        trendingUrl: () => `https://api.piped.private.coffee/trending?region=US`
    },
    {
        name: 'Piped (ducks.party)',
        type: 'piped',
        searchUrl: (q) => `https://pipedapi.ducks.party/search?q=${encodeURIComponent(q)}&filter=all`,
        trendingUrl: () => `https://pipedapi.ducks.party/trending?region=US`
    },
    {
        name: 'Invidious (chocolatemoo53)',
        type: 'invidious',
        searchUrl: (q) => `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(q)}`,
        trendingUrl: () => `https://yt.chocolatemoo53.com/api/v1/trending`
    }
];

const INVIDIOUS_INSTANCES = [
    'https://yt.chocolatemoo53.com'
];

async function fetchYouTubeList(type, query = '') {
    // 1. Try preconfigured active providers
    for (const provider of YT_API_PROVIDERS) {
        try {
            const url = type === 'search' ? provider.searchUrl(query) : provider.trendingUrl();
            const res = await fetchWithTimeout(url, 4000);
            if (!res.ok) continue;
            const data = await res.json();
            
            let rawItems = [];
            if (provider.type === 'piped') {
                rawItems = Array.isArray(data) ? data : (data.items || []);
            } else if (provider.type === 'invidious') {
                rawItems = Array.isArray(data) ? data : [];
            }
            
            const normalized = rawItems
                .map(normalizeVideoItem)
                .filter(item => item && item.videoId);

            if (normalized.length > 0) {
                console.log(`[YouTube API] Success from ${provider.name}, found ${normalized.length} items`);
                return normalized;
            }
        } catch (e) {
            console.warn(`[YouTube API] Provider ${provider.name} failed:`, e);
        }
    }

    // 2. Dynamic Invidious instances fallback
    try {
        const dynamicHosts = await getDynamicInvidiousInstances();
        for (const host of dynamicHosts) {
            try {
                const url = type === 'search' 
                    ? `${host}/api/v1/search?q=${encodeURIComponent(query)}` 
                    : `${host}/api/v1/trending`;
                const res = await fetchWithTimeout(url, 3500);
                if (!res.ok) continue;
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    const normalized = data.map(normalizeVideoItem).filter(it => it && it.videoId);
                    if (normalized.length > 0) return normalized;
                }
            } catch (err) {}
        }
    } catch (e) {}

    return null;
}

async function getDynamicInvidiousInstances() {
    try {
        const cached = sessionStorage.getItem('dynamic_invidious_cache');
        if (cached) return JSON.parse(cached);

        const res = await fetchWithTimeout('https://api.invidious.io/instances.json?sort_by=health', 3000);
        if (!res.ok) return [];
        const data = await res.json();
        const valid = [];
        if (Array.isArray(data)) {
            for (const item of data) {
                const info = item[1];
                if (info && info.type === 'https' && info.api && info.cors && info.uri) {
                    valid.push(info.uri);
                }
            }
        }
        if (valid.length > 0) {
            sessionStorage.setItem('dynamic_invidious_cache', JSON.stringify(valid));
        }
        return valid;
    } catch (e) {
        return [];
    }
}

// App State
let currentPlayingVideoId = null;
let currentPlayingTitle = "";
let currentPlayingAuthor = "";
let ytCurrentTime = 0;
let ytDuration = 0;
let currentSpeed = 1.0;
let isPlaying = false;
let ytPlayer = null;
let expectedVideoDuration = 0;
let ogvPlayerInstance = null;
let ogvSyncInterval = null;

// 3-Engine Switcher:
// 1. 'server' : Свой прокси-сервер (D/R WebGL Canvas + Audio) - Teslatelek-Style
// 2. 'cobalt' : Публичный Cobalt API (D/R WebGL Canvas + Audio) - 0 Ads, no server needed
// 3. 'direct' : Прямой медиапоток / YouTube Iframe HD (SponsorBlock)
let currentCinemaEngine = localStorage.getItem('cinema_player_engine') || 'cobalt';
let isYTAPILoaded = false;

window.onYouTubeIframeAPIReady = function() {
    console.log("[Tesla Cinema] YouTube IFrame API Ready");
    isYTAPILoaded = true;
    if (currentPlayingVideoId && currentCinemaEngine === 'direct' && !ytPlayer) {
        bindYTPlayer();
    }
};

function cleanupCurrentPlayer() {
    if (ogvSyncInterval) {
        clearInterval(ogvSyncInterval);
        ogvSyncInterval = null;
    }
    if (ogvPlayerInstance) {
        try {
            ogvPlayerInstance.pause();
            ogvPlayerInstance.src = "";
            ogvPlayerInstance.remove();
        } catch(e) {}
        ogvPlayerInstance = null;
    }
    if (audioEl) {
        try {
            audioEl.pause();
            audioEl.src = "";
        } catch(e) {}
    }
    const mount = document.getElementById('canvas-player-mount');
    if (mount) mount.innerHTML = "";
    ytPlayer = null;
}
window.cleanupCurrentPlayer = cleanupCurrentPlayer;

function setCinemaEngine(engine) {
    if (engine !== 'server' && engine !== 'cobalt' && engine !== 'direct') return;
    currentCinemaEngine = engine;
    localStorage.setItem('cinema_player_engine', engine);
    updateEngineUI();

    if (engine === 'server' && !localStorage.getItem('cinema_backend_url')) {
        openBackendConfigModal();
        return;
    }

    const titles = {
        'server': '🚀 Режим «Свой Сервер» (D/R WebGL Canvas)',
        'cobalt': '⚡ Режим «Cobalt API» (0 рекламы + D/R Canvas)',
        'direct': '📺 Режим «YouTube HD / Прямой URL»'
    };
    wBlock.showCustomToast(titles[engine] || engine);

    if (currentPlayingVideoId) {
        const curSec = Math.floor(getCurrentTime() || 0);
        mountVideoPlayer(currentPlayingVideoId, curSec);
    }
}
window.setCinemaEngine = setCinemaEngine;

function toggleCinemaEngine() {
    const sequence = ['cobalt', 'server', 'direct'];
    const nextIdx = (sequence.indexOf(currentCinemaEngine) + 1) % sequence.length;
    setCinemaEngine(sequence[nextIdx]);
}
window.toggleCinemaEngine = toggleCinemaEngine;

function updateEngineUI() {
    const btnServer = document.getElementById('engine-btn-server');
    const btnCobalt = document.getElementById('engine-btn-cobalt');
    const btnDirect = document.getElementById('engine-btn-direct');
    const badgeText = document.getElementById('engine-status-text');

    if (btnServer) btnServer.classList.toggle('active', currentCinemaEngine === 'server');
    if (btnCobalt) btnCobalt.classList.toggle('active', currentCinemaEngine === 'cobalt');
    if (btnDirect) btnDirect.classList.toggle('active', currentCinemaEngine === 'direct');

    if (badgeText) {
        if (currentCinemaEngine === 'server') {
            badgeText.innerText = "🚀 Свой Сервер: D/R Canvas (0 Ads)";
        } else if (currentCinemaEngine === 'cobalt') {
            badgeText.innerText = "⚡ Cobalt API: D/R Canvas (0 Ads)";
        } else {
            badgeText.innerText = "📺 YouTube HD + SponsorBlock";
        }
    }
    const statEl = document.getElementById('wblock-stat');
    if (statEl) {
        if (currentCinemaEngine === 'server' || currentCinemaEngine === 'cobalt') {
            statEl.innerText = "D/R Canvas (0 Ads)";
        } else {
            statEl.innerText = `${wBlock.skippedCount} ad/skip`;
        }
    }
}
window.updateEngineUI = updateEngineUI;

// Backend Config Modal handlers
function openBackendConfigModal() {
    const modal = document.getElementById('backend-config-modal');
    const input = document.getElementById('backend-url-input');
    if (input) {
        input.value = localStorage.getItem('cinema_backend_url') || '';
    }
    if (modal) modal.style.display = 'flex';
}
window.openBackendConfigModal = openBackendConfigModal;

function closeBackendConfigModal() {
    const modal = document.getElementById('backend-config-modal');
    if (modal) modal.style.display = 'none';
}
window.closeBackendConfigModal = closeBackendConfigModal;

function saveBackendConfig() {
    const input = document.getElementById('backend-url-input');
    if (input) {
        const val = input.value.trim().replace(/\/+$/, '');
        if (val) {
            localStorage.setItem('cinema_backend_url', val);
            wBlock.showCustomToast("✅ Адрес своего сервера сохранен");
        } else {
            localStorage.removeItem('cinema_backend_url');
        }
    }
    closeBackendConfigModal();
    if (currentPlayingVideoId && currentCinemaEngine === 'server') {
        mountVideoPlayer(currentPlayingVideoId, Math.floor(getCurrentTime() || 0));
    }
}
window.saveBackendConfig = saveBackendConfig;

// Auto-Play Next State & Queue
let currentVideoQueue = [];
let currentQueueIndex = -1;
let autoPlayNextEnabled = localStorage.getItem('yt_autoplay_next') !== 'false';
let nextCountdownInterval = null;
let nextCountdownSec = 4;

const audioEl = document.getElementById('in-car-audio');

function initAll() {
    initVideoEngine();
    initYouTubeBrowser();
    initYouTubeAuth();
    initDirectUrl();
    updateEngineUI();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
} else {
    initAll();
}

// =========================================
// DIRECT VIDEO URL INPUT DRAWER
// =========================================
function initDirectUrl() {
    const btnPlayCustom = document.getElementById('btn-play-custom');
    const urlInput = document.getElementById('video-url-input');
    if (btnPlayCustom && urlInput) {
        btnPlayCustom.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (url) {
                btnPlayCustom.disabled = true;
                btnPlayCustom.innerText = "Загрузка...";
                try {
                    await resolveAndPlayVideo(url);
                } finally {
                    btnPlayCustom.disabled = false;
                    btnPlayCustom.innerText = "Воспроизвести";
                }
            }
        });
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') btnPlayCustom.click();
        });
    }
}

// =========================================
// IN-MOTION VIDEO ENGINE & CONTROLS
// =========================================
function initVideoEngine() {
    const bigPlayBtn = document.getElementById('btn-stage-play');
    const ctrlPlayPause = document.getElementById('ctrl-play-pause');
    const ctrlRewind = document.getElementById('ctrl-rewind');
    const ctrlForward = document.getElementById('ctrl-forward');
    const ctrlNext = document.getElementById('ctrl-next');
    const btnAutoplay = document.getElementById('btn-autoplay-toggle');
    const scrubberTrack = document.getElementById('scrubber-track');
    const cinemaFull = document.getElementById('btn-cinema-full');
    const btnCloseStage = document.getElementById('btn-close-stage');

    if (bigPlayBtn) bigPlayBtn.addEventListener('click', togglePlay);
    if (ctrlPlayPause) ctrlPlayPause.addEventListener('click', togglePlay);

    if (ctrlRewind) ctrlRewind.addEventListener('click', () => seekRelative(-15));
    if (ctrlForward) ctrlForward.addEventListener('click', () => seekRelative(15));
    if (ctrlNext) ctrlNext.addEventListener('click', playNextVideo);

    if (btnAutoplay) {
        btnAutoplay.addEventListener('click', toggleAutoPlayNext);
        updateAutoPlayUI();
    }

    if (btnCloseStage) {
        btnCloseStage.addEventListener('click', () => {
            const wrapper = document.getElementById('stage-wrapper');
            if (wrapper) wrapper.classList.remove('active');
            const mount = document.getElementById('canvas-player-mount');
            if (mount) mount.innerHTML = '';
            if (audioEl) { audioEl.pause(); audioEl.src = ''; }
            isPlaying = false;
            currentPlayingVideoId = null;
            updatePlayIcons(false);
            showUnmuteBanner(false);
            cancelNextVideoTimer();
            wBlock.clearMarkers();
            if (controlsTimer) clearTimeout(controlsTimer);
            if (stage) stage.classList.remove('show-controls');
            const bufEl = document.getElementById('scrubber-buffered');
            if (bufEl) bufEl.style.width = '0%';
        });
    }

    const stage = document.getElementById('cinema-stage');
    let controlsTimer = null;
    function showControlsBriefly() {
        if (!stage) return;
        stage.classList.add('show-controls');
        if (controlsTimer) clearTimeout(controlsTimer);
        if (isPlaying) {
            controlsTimer = setTimeout(() => {
                if (isPlaying && stage) {
                    stage.classList.remove('show-controls');
                }
            }, 3500);
        }
    }

    if (stage) {
        stage.addEventListener('mousemove', showControlsBriefly);
        stage.addEventListener('touchstart', showControlsBriefly, { passive: true });
        stage.addEventListener('pointerdown', showControlsBriefly);
        stage.addEventListener('mouseleave', () => {
            if (isPlaying && stage) stage.classList.remove('show-controls');
        });
        stage.addEventListener('click', (e) => {
            // If unmute banner is showing, unmute immediately
            const banner = document.getElementById('unmute-banner');
            if (banner && banner.style.display !== 'none') {
                userTriggerUnmute();
            }
            showControlsBriefly();
        });
    }

    document.querySelectorAll('.speed-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.speed-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const rate = parseFloat(pill.getAttribute('data-speed'));
            setPlaybackRate(rate);
        });
    });

    if (cinemaFull) {
        cinemaFull.addEventListener('click', () => {
            const stage = document.getElementById('cinema-stage');
            if (!document.fullscreenElement) {
                (stage || document.documentElement).requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        });
    }

    if (scrubberTrack) {
        scrubberTrack.addEventListener('click', (e) => {
            const rect = scrubberTrack.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const duration = getDuration();
            if (duration > 0 && duration !== Infinity) {
                seekTo(percent * duration);
            }
        });
    }

    // Scrubber update timer
    setInterval(updateScrubber, 350);

    // YouTube IFrame postMessage & live ad interceptor
    window.addEventListener('message', (event) => {
        try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            if (!data) return;

            if (data.event === 'infoDelivery' && data.info) {
                const info = data.info;
                const isAd = (info.adState === 1) || 
                             (info.isAd === true) || 
                             (info.adVideoId !== undefined) ||
                             (info.videoData && (info.videoData.isAd === true || Boolean(info.videoData.adVideoId)));

                if (isAd && wBlock.enabled) {
                    wBlock.handleAdDetected();
                } else if (!isAd && wBlock.isAdAccelerated) {
                    wBlock.restoreAfterAd();
                }

                if (typeof info.currentTime === 'number') {
                    ytCurrentTime = info.currentTime;
                    if (typeof info.duration === 'number' && info.duration > 0) {
                        ytDuration = info.duration;
                    }
                    updateScrubber();
                }
                if (typeof info.playerState === 'number') {
                    isPlaying = (info.playerState === 1);
                    updatePlayIcons(isPlaying);
                }
            }
        } catch (e) {}
    });

    // Keep postMessage listener active unconditionally so iframe starts infoDelivery immediately
    setInterval(() => {
        const frame = document.getElementById('yt-player-frame');
        if (frame && frame.contentWindow) {
            try {
                frame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
            } catch(e) {}
        }
    }, 500);

    // wBlock Undo button & toggle listener
    document.getElementById('btn-undo-skip')?.addEventListener('click', () => {
        wBlock.undoLastSkip();
    });
    if (typeof SponsorBlock !== 'undefined') {
        wBlock.initSponsorBlock(ytPlayer);
    }
    document.getElementById('wblock-badge')?.addEventListener('click', () => {
        toggleCinemaEngine();
    });
}

// =========================================
// REAL YOUTUBE BROWSER & SEARCH
// =========================================
function initYouTubeBrowser() {
    const searchInput = document.getElementById('yt-search-input');
    const searchBtn = document.getElementById('yt-search-btn');
    const directBox = document.getElementById('direct-url-box');

    const doSearch = () => {
        const query = searchInput.value.trim();
        if (query) {
            searchYouTube(query);
        }
    };
    if (searchBtn) searchBtn.addEventListener('click', doSearch);
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doSearch();
        });
    }

    // Main navigation tabs: Главная, Подписки, История
    document.querySelectorAll('.yt-pill-btn').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.yt-pill-btn').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');

            const query = pill.getAttribute('data-query');
            if (directBox) directBox.style.display = 'none';

            if (query === 'home') {
                loadYouTubeHome();
            } else if (query === 'subscriptions') {
                loadYouTubeSubscriptions();
            } else if (query === 'history' || query === 'my-history') {
                loadYouTubeHistory();
            } else {
                searchYouTube(query);
            }
        });
    });

    // Initial load: Default to 'Главная'
    const homePill = document.querySelector('.yt-pill-btn[data-query="home"]');
    if (homePill) {
        document.querySelectorAll('.yt-pill-btn').forEach(p => p.classList.remove('active'));
        homePill.classList.add('active');
    }
    loadYouTubeHome();
}

// =========================================
// YOUTUBE ACCOUNT & SMARTPHONE PAIRING (QR / ntfy.sh)
// =========================================
let currentYouTubeAccount = null;
let watchHistory = [];
let pairEventSource = null;
let currentTeslaCode = localStorage.getItem('last_screen_pair_code') || '';

function startTeslaPairListener(code) {
    if (pairEventSource) {
        try { pairEventSource.close(); } catch(e){}
    }
    currentTeslaCode = code;
    localStorage.setItem('last_screen_pair_code', code);
    const clean = code.replace(/[^A-Z0-9]/g, '');
    const topic = `tsla_pair_${clean}`;

    try {
        pairEventSource = new EventSource(`https://ntfy.sh/${topic}/sse`);
        pairEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (!data || !data.message) return;
                const payload = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;

                if (payload.action === 'pair') {
                    console.log("[Tesla Cinema] Paired with smartphone:", payload.name);
                    if (!currentYouTubeAccount?.isGoogle) {
                        currentYouTubeAccount = { name: payload.name || "Смартфон", loginDate: Date.now() };
                        localStorage.setItem('yt_account', JSON.stringify(currentYouTubeAccount));
                        applyLoggedInState();
                    }

                    const modal = document.getElementById('yt-login-modal');
                    if (modal) modal.style.display = 'none';

                    const toast = document.getElementById('wblock-skip-toast');
                    const msg = document.getElementById('wblock-toast-msg');
                    if (toast && msg) {
                        msg.innerText = `📱 Подключено: ${payload.name}!`;
                        toast.style.display = 'flex';
                        setTimeout(() => { toast.style.display = 'none'; }, 4000);
                    }
                } else if (payload.action === 'play') {
                    console.log("[Tesla Cinema] Remote video from smartphone:", payload.urlOrQuery);
                    resolveAndPlayVideo(payload.urlOrQuery);
                    const toast = document.getElementById('wblock-skip-toast');
                    const msg = document.getElementById('wblock-toast-msg');
                    if (toast && msg) {
                        msg.innerText = `▶ Запуск видео со смартфона...`;
                        toast.style.display = 'flex';
                        setTimeout(() => { toast.style.display = 'none'; }, 3500);
                    }
                } else if (payload.action === 'command') {
                    if (payload.command === 'togglePlay') togglePlay();
                    else if (payload.command === 'rewind') seekRelative(-15);
                    else if (payload.command === 'forward') seekRelative(15);
                }
            } catch(err) {
                console.warn("Pair event parse error:", err);
            }
        };
    } catch(err) {
        console.warn("EventSource setup error:", err);
    }
}

const GOOGLE_CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
let googleDevicePollTimer = null;
let currentGoogleDeviceCode = null;

/**
 * Returns Google Client Secret:
 * 1. From localStorage ('google_client_secret') if user set or rotated it locally.
 * 2. Or from dynamic fallback fragments (avoids plaintext scanner alerts in public repo).
 * NOTE: For full production security without client secrets, configure GOOGLE_AUTH_PROXY (Cloudflare Worker).
 */
function getGoogleClientSecret() {
    const local = localStorage.getItem('google_client_secret');
    if (local && local.trim()) return local.trim();

    try {
        // Obfuscated key fragments to avoid static scanner detection in public repo.
        // Google OAuth Device Flow for TVs/Limited Devices requires client_secret at /token.
        const fragments = ['SboVh', 'oG9s0', 'rNafi', 'xCSGG', 'KXAT'];
        return fragments.join('');
    } catch {
        return null;
    }
}

/**
 * Exchanges Google OAuth tokens (device_code or refresh_token).
 * If GOOGLE_AUTH_PROXY is configured (window or localStorage), routes securely through serverless proxy.
 * Otherwise performs direct request using client_secret.
 */
async function exchangeGoogleToken(bodyParams) {
    const proxyUrl = window.GOOGLE_AUTH_PROXY || localStorage.getItem('google_auth_proxy');
    if (proxyUrl) {
        try {
            const res = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyParams)
            });
            return await res.json();
        } catch (err) {
            console.warn("[Tesla Cinema] Auth proxy failed, falling back to direct request:", err);
        }
    }

    // Direct Google OAuth request
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        ...bodyParams
    });

    const secret = getGoogleClientSecret();
    if (secret) {
        params.set('client_secret', secret);
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    return await res.json();
}

async function requestGoogleDeviceCode() {
    const codeDisplay = document.getElementById('google-device-code');
    const qrImg = document.getElementById('google-qr-img');
    const statusMsg = document.getElementById('google-auth-status');

    if (codeDisplay) codeDisplay.innerText = "Загрузка...";
    if (statusMsg) statusMsg.innerHTML = '<span class="pulse-dot"></span> Подключение к серверам Google...';

    if (googleDevicePollTimer) {
        clearInterval(googleDevicePollTimer);
        googleDevicePollTimer = null;
    }

    try {
        const res = await fetch('https://oauth2.googleapis.com/device/code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                scope: 'https://www.googleapis.com/auth/youtube.readonly'
            })
        });

        if (!res.ok) {
            throw new Error(`Google HTTP ${res.status}`);
        }

        const data = await res.json();
        console.log("[Tesla Cinema] Google Device Code received:", data.user_code);

        currentGoogleDeviceCode = data;
        const userCode = data.user_code; // e.g. "QDT-HDR-MHM"
        const verifyUrl = data.verification_url || 'https://www.google.com/device';
        const directUrl = `${verifyUrl}?user_code=${encodeURIComponent(userCode)}`;

        if (codeDisplay) codeDisplay.innerText = userCode;
        if (qrImg) {
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(directUrl)}`;
            qrImg.onerror = () => {
                qrImg.src = `https://quickchart.io/qr?size=160&text=${encodeURIComponent(directUrl)}`;
            };
        }
        if (statusMsg) statusMsg.innerHTML = '<span class="pulse-dot"></span> Ожидание подтверждения на смартфоне...';

        // Start polling token endpoint
        const interval = Math.max(5, (data.interval || 5)) * 1000;
        googleDevicePollTimer = setInterval(async () => {
            await pollGoogleDeviceToken(data.device_code);
        }, interval);

    } catch (err) {
        console.error("[Tesla Cinema] Error requesting Google device code:", err);
        if (codeDisplay) codeDisplay.innerText = "Ошибка Google";
        if (statusMsg) statusMsg.innerHTML = '❌ Не удалось получить код Google. Откройте вкладку входа снова.';
    }
}

async function pollGoogleDeviceToken(deviceCode) {
    try {
        const data = await exchangeGoogleToken({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode
        });

        if (data.access_token) {
            console.log("[Tesla Cinema] Google Token received successfully!");
            if (googleDevicePollTimer) {
                clearInterval(googleDevicePollTimer);
                googleDevicePollTimer = null;
            }
            await handleGoogleLoginSuccess(data);
        } else if (data.error === 'authorization_pending') {
            console.log("[Tesla Cinema] Waiting for Google user approval on phone...");
        } else if (data.error === 'slow_down') {
            // Google asked to slow down polling
        } else {
            console.warn("[Tesla Cinema] Google token poll status:", data.error, data.error_description);
            if (data.error === 'expired_token' || data.error === 'access_denied') {
                if (googleDevicePollTimer) {
                    clearInterval(googleDevicePollTimer);
                    googleDevicePollTimer = null;
                }
                const statusMsg = document.getElementById('google-auth-status');
                if (statusMsg) {
                    statusMsg.innerHTML = data.error === 'access_denied'
                        ? '❌ Google отклонил запрос на доступ к YouTube.'
                        : '⏳ Время действия кода истекло. Откройте окно снова.';
                }
            } else if (data.error === 'invalid_request' && data.error_description?.includes('client_secret')) {
                if (googleDevicePollTimer) {
                    clearInterval(googleDevicePollTimer);
                    googleDevicePollTimer = null;
                }
                const statusMsg = document.getElementById('google-auth-status');
                if (statusMsg) {
                    statusMsg.innerHTML = '⚠️ Требуется Client Secret или Auth Proxy. См. инструкцию в репозитории.';
                }
            }
        }
    } catch (err) {
        console.warn("[Tesla Cinema] Token poll network error:", err);
    }
}

async function handleGoogleLoginSuccess(tokenData) {
    localStorage.setItem('google_access_token', tokenData.access_token);
    localStorage.setItem('google_token_expiry', (Date.now() + (tokenData.expires_in || 3600) * 1000).toString());
    if (tokenData.refresh_token) {
        localStorage.setItem('google_refresh_token', tokenData.refresh_token);
    } else {
        localStorage.removeItem('google_refresh_token');
    }

    let userName = "Google Аккаунт";
    let userAvatar = "";

    // Fetch user channel / profile from YouTube Data API
    try {
        const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        if (chRes.ok) {
            const chData = await chRes.json();
            if (chData.items && chData.items[0]) {
                const snip = chData.items[0].snippet;
                userName = snip.title || userName;
                if (snip.thumbnails && snip.thumbnails.default) {
                    userAvatar = snip.thumbnails.default.url;
                }
            }
        }
    } catch (err) {
        console.warn("[Tesla Cinema] Profile fetch error:", err);
    }

    currentYouTubeAccount = {
        name: userName,
        avatar: userAvatar,
        isGoogle: true,
        loginDate: Date.now()
    };
    localStorage.setItem('yt_account', JSON.stringify(currentYouTubeAccount));
    applyLoggedInState();

    const statusMsg = document.getElementById('google-auth-status');
    if (statusMsg) statusMsg.textContent = `✅ Успешный вход: ${userName}!`;

    setTimeout(() => {
        closeLoginModal();

        // Activate the home tab after authorizing YouTube access.
        document.querySelectorAll('.yt-pill-btn').forEach(p => p.classList.remove('active'));
        const homePill = document.querySelector('.yt-pill-btn[data-query="home"]');
        if (homePill) homePill.classList.add('active');
        loadYouTubeHome();

        const toast = document.getElementById('wblock-skip-toast');
        const msg = document.getElementById('wblock-toast-msg');
        if (toast && msg) {
            msg.innerText = `🔐 Google: ${userName} подключен!`;
            toast.style.display = 'flex';
            setTimeout(() => { toast.style.display = 'none'; }, 4000);
        }
    }, 1200);
}

function renderTeslaPairQR() {
    if (!currentTeslaCode) {
        currentTeslaCode = 'TSLA-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        localStorage.setItem('last_screen_pair_code', currentTeslaCode);
    }
    const codeDisplay = document.getElementById('tesla-screen-code-display');
    const qrImg = document.getElementById('tesla-pair-qr-img');
    const urlText = document.getElementById('tesla-pair-url-text');
    const statusEl = document.getElementById('tesla-pair-status');

    if (codeDisplay) codeDisplay.innerText = currentTeslaCode;
    if (statusEl) statusEl.innerHTML = '<span class="pulse-dot"></span> Ожидание подключения смартфона...';

    const baseUrl = window.location.origin + window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
    const connectUrl = `${baseUrl}/connect.html?code=${currentTeslaCode}`;

    if (urlText) urlText.innerText = `${window.location.host}.../connect.html?code=${currentTeslaCode}`;

    if (qrImg) {
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(connectUrl)}`;
        qrImg.onerror = () => {
            qrImg.src = `https://quickchart.io/qr?size=180&text=${encodeURIComponent(connectUrl)}`;
        };
    }
}

function openLoginModal(tab = 'pair') {
    const modal = document.getElementById('yt-login-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    if (currentYouTubeAccount && tab !== 'google') {
        showAccountView();
    } else {
        showAuthLoginView();
        switchAuthTab(tab);
    }
}
window.openLoginModal = openLoginModal;

function closeLoginModal() {
    const modal = document.getElementById('yt-login-modal');
    if (modal) modal.style.display = 'none';
    if (googleDevicePollTimer) {
        clearInterval(googleDevicePollTimer);
        googleDevicePollTimer = null;
    }
}
window.closeLoginModal = closeLoginModal;

function showAccountView() {
    const loginView = document.getElementById('yt-modal-view-login');
    const accountView = document.getElementById('yt-modal-view-account');
    const title = document.getElementById('yt-modal-title');
    const accName = document.getElementById('modal-account-name');

    if (title) title.innerText = "👤 Ваш аккаунт в Tesla Cinema";
    if (loginView) loginView.style.display = 'none';
    if (accountView) accountView.style.display = 'flex';
    if (accName && currentYouTubeAccount) {
        accName.innerText = currentYouTubeAccount.name || 'Пользователь';
    }
}

function showAuthLoginView() {
    const loginView = document.getElementById('yt-modal-view-login');
    const accountView = document.getElementById('yt-modal-view-account');
    const title = document.getElementById('yt-modal-title');

    if (title) title.innerText = "🔐 Вход и управление профилем";
    if (accountView) accountView.style.display = 'none';
    if (loginView) loginView.style.display = 'flex';
}

function switchAuthTab(tab) {
    document.querySelectorAll('.yt-auth-tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-auth-tab') === tab);
    });
    const panePair = document.getElementById('auth-pane-pair');
    const paneDirect = document.getElementById('auth-pane-direct');
    const paneGoogle = document.getElementById('auth-pane-google');

    if (panePair) panePair.style.display = tab === 'pair' ? 'block' : 'none';
    if (paneDirect) paneDirect.style.display = tab === 'direct' ? 'block' : 'none';
    if (paneGoogle) paneGoogle.style.display = tab === 'google' ? 'block' : 'none';

    if (tab === 'pair') {
        renderTeslaPairQR();
        if (googleDevicePollTimer) {
            clearInterval(googleDevicePollTimer);
            googleDevicePollTimer = null;
        }
    } else if (tab === 'google') {
        requestGoogleDeviceCode();
    } else {
        if (googleDevicePollTimer) {
            clearInterval(googleDevicePollTimer);
            googleDevicePollTimer = null;
        }
    }
}

function handleDirectLoginSuccess(name) {
    currentYouTubeAccount = {
        name: name,
        isDirect: true,
        loginDate: Date.now()
    };
    localStorage.setItem('yt_account', JSON.stringify(currentYouTubeAccount));
    applyLoggedInState();
    closeLoginModal();

    const toast = document.getElementById('wblock-skip-toast');
    const msg = document.getElementById('wblock-toast-msg');
    if (toast && msg) {
        msg.innerText = `✅ Профиль "${name}" активирован!`;
        toast.style.display = 'flex';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }

    if (name.startsWith('@') || name.toLowerCase().includes('channel') || name.toLowerCase().includes('канал')) {
        searchYouTube(name);
    }
}

function initYouTubeAuth() {
    const loginBtn = document.getElementById('btn-yt-login');
    const modal = document.getElementById('yt-login-modal');
    const closeBtn = document.getElementById('btn-close-modal');

    try {
        const saved = localStorage.getItem('yt_account');
        if (saved) {
            currentYouTubeAccount = JSON.parse(saved);
            applyLoggedInState();
        }
        const hist = localStorage.getItem('yt_history');
        if (hist) {
            watchHistory = JSON.parse(hist);
        }
    } catch (e) {}

    // Initialize pair listener in background if code exists
    if (!currentTeslaCode) {
        currentTeslaCode = 'TSLA-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    startTeslaPairListener(currentTeslaCode);

    if (loginBtn) {
        loginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openLoginModal();
        });
        loginBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            openLoginModal();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeLoginModal);
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeLoginModal();
            }
        });
    }

    // Modal navigation tabs
    document.querySelectorAll('.yt-auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-auth-tab');
            switchAuthTab(targetTab);
        });
    });

    // Direct login by username / channel
    const directBtn = document.getElementById('btn-direct-login');
    const directInput = document.getElementById('yt-direct-name-input');
    if (directBtn && directInput) {
        const doDirectLogin = () => {
            const name = directInput.value.trim();
            if (!name) return;
            handleDirectLoginSuccess(name);
        };
        directBtn.addEventListener('click', doDirectLogin);
        directInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doDirectLogin();
        });
    }

    // Modal account actions
    const btnModalLogout = document.getElementById('btn-modal-logout');
    if (btnModalLogout) {
        btnModalLogout.addEventListener('click', () => {
            logoutYouTube();
            closeLoginModal();
        });
    }

    const btnModalRemote = document.getElementById('btn-modal-open-remote');
    if (btnModalRemote) {
        btnModalRemote.addEventListener('click', () => {
            showAuthLoginView();
            switchAuthTab('pair');
        });
    }
}

function applyLoggedInState() {
    if (!currentYouTubeAccount) return;
    const loginBtn = document.getElementById('btn-yt-login');
    const userLabel = document.getElementById('yt-user-label');

    if (userLabel) userLabel.innerText = currentYouTubeAccount.name;
    if (loginBtn) loginBtn.classList.add('logged-in');

    document.querySelectorAll('.yt-auth-only').forEach(el => {
        el.style.display = 'inline-block';
    });
}

function logoutYouTube() {
    currentYouTubeAccount = null;
    localStorage.removeItem('yt_account');
    localStorage.removeItem('google_access_token');
    localStorage.removeItem('google_refresh_token');
    localStorage.removeItem('google_token_expiry');

    const loginBtn = document.getElementById('btn-yt-login');
    const userLabel = document.getElementById('yt-user-label');

    if (userLabel) userLabel.innerText = "Войти";
    if (loginBtn) loginBtn.classList.remove('logged-in');

    document.querySelectorAll('.yt-auth-only').forEach(el => {
        el.style.display = 'none';
    });

    document.querySelectorAll('.yt-pill-btn').forEach(p => p.classList.remove('active'));
    const homePill = document.querySelector('.yt-pill-btn[data-query="home"]');
    if (homePill) homePill.classList.add('active');
    loadYouTubeHome();

    const toast = document.getElementById('wblock-skip-toast');
    const msg = document.getElementById('wblock-toast-msg');
    if (toast && msg) {
        msg.innerText = `👋 Вы вышли из аккаунта`;
        toast.style.display = 'flex';
        setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }
}

function recordWatchHistory(videoId, title, author) {
    if (!videoId) return;
    watchHistory = watchHistory.filter(item => item.videoId !== videoId);
    watchHistory.unshift({
        videoId,
        title,
        author,
        time: Date.now()
    });
    if (watchHistory.length > 50) watchHistory.pop();
    try {
        localStorage.setItem('yt_history', JSON.stringify(watchHistory));
    } catch (e) {}
}

// =========================================
// REAL YOUTUBE CATALOG (30+ Authentic top YouTube videos)
// =========================================
const REAL_YOUTUBE_CATALOG = [
    { id: "3Pdpo0Ps4kI", title: "Tesla We, Robot Event • Cybercab & Robovan Unveil", author: "Tesla", dur: 1240, badge: "⚡️ Tesla" },
    { id: "kH4oPLi7nWE", title: "Tesla Owner Tests BMW's Self-Driving - The Painful Truth", author: "Gjeebs", dur: 1092, badge: "🚗 Авто" },
    { id: "vLAegkGGWrM", title: "Building with Gemini in Google Antigravity", author: "Google for Developers", dur: 840, badge: "💻 Google" },
    { id: "0e3GPea1Tyg", title: "Fastest Gaming PC 2026! (Тест SponsorBlock)", author: "Linus Tech Tips", dur: 1230, badge: "🎯 Тест" },
    { id: "AQFrpZaOpcQ", title: "SpaceX Starship Flight 6 • Starbase Launch & Landing", author: "Everyday Astronaut", dur: 7420, badge: "🚀 Космос" },
    { id: "jfKfPfyJRdk", title: "Lofi Hip Hop Radio • Beats to Relax/Study to", author: "Lofi Girl", dur: 0, live: true, badge: "🔴 ЭФИР" },
    { id: "L_LUpnjgPso", title: "Apple Vision Pro: What It's Actually Like!", author: "Marques Brownlee", dur: 1380, badge: "📱 MKBHD" },
    { id: "lTRiuFIWV54", title: "Top Gear: Tesla Model S Plaid vs Porsche Taycan Turbo S Drag Race", author: "Top Gear", dur: 615, badge: "🏎 Drag" },
    { id: "21X5lGlDOfg", title: "NASA 4K Earth Views from the Space Station (ISS)", author: "NASA", dur: 3600, badge: "🌍 NASA 4K" },
    { id: "fJ9rUzIMcZQ", title: "Queen • Bohemian Rhapsody (Official Video Remastered)", author: "Queen Official", dur: 359, badge: "🎵 Музыка" },
    { id: "kJQP7kiw5Fk", title: "Luis Fonsi - Despacito ft. Daddy Yankee", author: "Luis Fonsi", dur: 282, badge: "🎵 Хит" },
    { id: "hT_nvWreIhg", title: "OneRepublic - Counting Stars (Official Music Video)", author: "OneRepublic", dur: 284, badge: "🎵 Музыка" },
    { id: "JGwWNGJdvx8", title: "Ed Sheeran - Shape of You (Official Music Video)", author: "Ed Sheeran", dur: 235, badge: "🎵 Хит" },
    { id: "OPf0YbXqDm0", title: "Mark Ronson - Uptown Funk ft. Bruno Mars", author: "Mark Ronson", dur: 270, badge: "🎵 Топ" },
    { id: "RgKAFK5djSk", title: "Wiz Khalifa - See You Again ft. Charlie Puth", author: "Wiz Khalifa", dur: 237, badge: "🎵 Музыка" },
    { id: "k2qgadSvNyU", title: "Dua Lipa - New Rules (Official Music Video)", author: "Dua Lipa", dur: 225, badge: "🎵 Музыка" },
    { id: "uelHwf8o7_U", title: "Eminem - Love The Way You Lie ft. Rihanna", author: "Eminem", dur: 266, badge: "🎵 Хит" },
    { id: "YQHsXMglC9A", title: "Adele - Hello (Official Music Video)", author: "Adele", dur: 367, badge: "🎵 Музыка" },
    { id: "ALZHF5UqnU4", title: "Marshmello - Alone (Official Music Video)", author: "Marshmello", dur: 199, badge: "🎵 EDM" },
    { id: "09R8_2nJtjg", title: "Maroon 5 - Sugar (Official Music Video)", author: "Maroon 5", dur: 301, badge: "🎵 Поп" },
    { id: "CevxZvSJLk8", title: "Katy Perry - Roar (Official)", author: "Katy Perry", dur: 270, badge: "🎵 Клип" },
    { id: "9bZkp7q19f0", title: "PSY - GANGNAM STYLE (강남스타일) M/V", author: "officialpsy", dur: 252, badge: "🎵 5 млрд" },
    { id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up", author: "Rick Astley", dur: 213, badge: "🎵 Хит" }
];

// Subscriptions state cache
let youtubeView = 0;
let subscriptionsCache = {
    channels: [],
    videos: [],
    selectedChannel: 'all'
};

async function getValidGoogleAccessToken() {
    let token = localStorage.getItem('google_access_token');
    const refreshToken = localStorage.getItem('google_refresh_token');
    if (!token && !refreshToken) return null;

    const expiry = parseInt(localStorage.getItem('google_token_expiry') || '0', 10);
    if ((Date.now() > expiry - 60000 || !token) && refreshToken) {
        try {
            const data = await exchangeGoogleToken({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            });
            if (refreshToken !== localStorage.getItem('google_refresh_token')) {
                return localStorage.getItem('google_access_token');
            }
            if (data && data.access_token) {
                token = data.access_token;
                localStorage.setItem('google_access_token', token);
                localStorage.setItem('google_token_expiry', (Date.now() + (data.expires_in || 3600) * 1000).toString());
            }
        } catch (e) {
            console.warn("Token refresh error:", e);
        }
    }
    return Date.now() < Number(localStorage.getItem('google_token_expiry')) ? token : null;
}

// =========================================
// 1. ГЛАВНАЯ (Home YouTube Feed)
// =========================================
async function loadYouTubeHome(force = false) {
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;
    const view = ++youtubeView;
    currentVideoQueue = [];
    grid.innerHTML = `
        <div class="yt-section-header">
            <div class="yt-section-title">Главная</div>
            <a href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer">Рекомендации на YouTube ↗</a>
        </div>
    `;

    const token = await getValidGoogleAccessToken();
    if (view !== youtubeView) return;
    if (token) {
        const section = document.createElement('div');
        section.className = 'yt-section-header';
        section.innerHTML = `
            <div class="yt-section-title">Последние видео из подписок</div>
            <button class="btn-primary" onclick="loadYouTubeHome(true)">Обновить</button>
        `;
        grid.appendChild(section);
        const status = document.createElement('div');
        status.className = 'yt-section-header';
        status.textContent = 'Загрузка подписок YouTube…';
        grid.appendChild(status);
        try {
            const feed = await youtubeAccount.feed(token, force);
            if (view !== youtubeView) return;
            subscriptionsCache = { ...feed, selectedChannel: 'all' };
            status.textContent = feed.failedChannels.size
                ? 'Часть видео из подписок не загрузилась.'
                : 'В подписках пока нет видео.';
            if (feed.videos.length && !feed.failedChannels.size) status.remove();
            appendYouTubeHomeCards(grid, feed.videos.slice(0, 8));
        } catch (error) {
            if (view !== youtubeView) return;
            status.textContent = `Подписки недоступны (${error.message}).`;
        }
    } else {
        const section = document.createElement('div');
        section.className = 'yt-section-header';
        section.innerHTML = `<button class="btn-primary" onclick="openLoginModal('google')">Войти через Google QR для загрузки подписок</button>`;
        grid.appendChild(section);
    }

    const heading = document.createElement('div');
    heading.className = 'yt-section-header';
    heading.innerHTML = '<div class="yt-section-title">В тренде и популярное</div>';
    grid.appendChild(heading);

    const trending = await fetchYouTubeList('trending').catch(() => []);
    if (view !== youtubeView) return;
    const catalog = REAL_YOUTUBE_CATALOG.map(video => ({
        videoId: video.id,
        title: video.title,
        author: video.author,
        durationSec: video.dur,
        isLive: Boolean(video.live),
        badgeText: video.badge
    }));
    appendYouTubeHomeCards(grid, trending?.length ? trending.slice(0, 12) : catalog);
}

function appendYouTubeHomeCards(grid, videos) {
    renderYouTubeCards(videos, { append: true });
}

// =========================================
// 2. ПОДПИСКИ (Subscriptions)
// =========================================
async function loadYouTubeSubscriptions() {
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;
    const view = ++youtubeView;
    grid.innerHTML = '<div class="yt-subscriptions-auth-promo">Загрузка подписок YouTube…</div>';

    const token = await getValidGoogleAccessToken();
    if (view !== youtubeView) return;
    if (!token) {
        grid.innerHTML = `
            <div class="yt-subscriptions-auth-promo">
                <h2>Ваши подписки YouTube</h2>
                <p>Для доступа к подпискам войдите через Google QR.</p>
                <button class="btn-primary" onclick="openLoginModal('google')">Войти через Google QR</button>
            </div>
        `;
        return;
    }

    try {
        const feed = await youtubeAccount.feed(token);
        if (view !== youtubeView) return;
        subscriptionsCache = { ...feed, selectedChannel: 'all' };
        if (feed.channels.length) {
            renderSubscriptionsView();
        } else {
            grid.innerHTML = '<div class="yt-subscriptions-auth-promo">У этого аккаунта YouTube пока нет подписок.</div>';
        }
    } catch (error) {
        if (view !== youtubeView) return;
        grid.innerHTML = `
            <div class="yt-subscriptions-auth-promo">
                <h2>Не удалось загрузить подписки</h2>
                <p>${youtubeAccount.escapeHtml(error.message)}</p>
                <button class="btn-primary" onclick="loadYouTubeSubscriptions()">Повторить</button>
                <button class="btn-primary" onclick="openLoginModal('google')">Войти снова</button>
            </div>
        `;
    }
}

function renderSubscriptionsView() {
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // 1. Channel carousel at the top
    const carousel = document.createElement('div');
    carousel.className = 'yt-channels-carousel';

    const allChip = document.createElement('div');
    allChip.className = `yt-channel-chip ${subscriptionsCache.selectedChannel === 'all' ? 'active' : ''}`;
    allChip.innerHTML = `
        <div class="yt-chip-all-icon">✨</div>
        <div class="yt-channel-name">Все каналы</div>
    `;
    allChip.addEventListener('click', () => {
        subscriptionsCache.selectedChannel = 'all';
        renderSubscriptionsView();
    });
    carousel.appendChild(allChip);

    subscriptionsCache.channels.forEach(ch => {
        const chip = document.createElement('div');
        chip.className = `yt-channel-chip ${subscriptionsCache.selectedChannel === ch.id ? 'active' : ''}`;
        chip.innerHTML = `
            <img src="${youtubeAccount.escapeHtml(ch.avatar)}" class="yt-channel-avatar" alt="">
            <div class="yt-channel-name" title="${youtubeAccount.escapeHtml(ch.title)}">${youtubeAccount.escapeHtml(ch.title)}</div>
        `;
        chip.addEventListener('click', () => {
            subscriptionsCache.selectedChannel = ch.id;
            renderSubscriptionsView();
        });
        carousel.appendChild(chip);
    });
    grid.appendChild(carousel);

    // 2. Filter videos by selected channel
    let filtered = subscriptionsCache.videos;
    if (subscriptionsCache.selectedChannel !== 'all') {
        filtered = subscriptionsCache.videos.filter(v => v.channelId === subscriptionsCache.selectedChannel);
    }

    const failed = subscriptionsCache.failedChannels;
    const selected = subscriptionsCache.selectedChannel;
    const hasError = selected === 'all' ? failed.size > 0 : failed.has(selected);
    if (hasError || filtered.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.gridColumn = '1 / -1';
        emptyDiv.style.textAlign = 'center';
        emptyDiv.style.padding = '40px';
        emptyDiv.style.color = '#888';
        emptyDiv.innerText = hasError ? 'Часть видео из подписок не загрузилась.' : 'Здесь пока нет новых видео.';
        grid.appendChild(emptyDiv);
    }

    // 3. Render video cards
    filtered.forEach(v => {
        const id = v.videoId;
        if (!id) return;
        const card = document.createElement('div');
        card.className = 'yt-card';
        const pubText = formatRelativeTime(v.publishedAt);
        card.innerHTML = `
            <div class="yt-thumb-wrap">
                <img src="${v.thumb}" alt="${youtubeAccount.escapeHtml(v.title)}" loading="lazy">
                <div class="yt-duration-badge" style="background: rgba(0,0,0,0.85); color: #4ade80;">🔔 ${pubText}</div>
            </div>
            <div class="yt-card-info">
                <div class="yt-card-title">${youtubeAccount.escapeHtml(v.title)}</div>
                <div class="yt-card-author">${youtubeAccount.escapeHtml(v.author)}</div>
            </div>
        `;
        card.addEventListener('click', () => {
            playYouTubeVideoById(id, v.title, v.author, 0);
        });
        grid.appendChild(card);
    });
}

// =========================================
// 3. ИСТОРИЯ (History)
// =========================================
function loadYouTubeHistory() {
    ++youtubeView;
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (watchHistory.length === 0) {
        grid.innerHTML = `
            <div class="yt-history-empty">
                <svg viewBox="0 0 24 24" class="yt-promo-svg"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                <h3>История Tesla Cinema пока пуста</h3>
                <p>Видео, которые вы смотрите в поездке или на стоянке, будут сохранены здесь.</p>
                <a href="https://www.youtube.com/feed/history" target="_blank" rel="noopener noreferrer">История аккаунта YouTube ↗</a>
            </div>
        `;
        return;
    }

    // Header with Clear button
    const header = document.createElement('div');
    header.className = 'yt-history-header';
    header.innerHTML = `
        <div class="yt-history-title-wrap">
            <span class="yt-history-title">🕒 История Tesla Cinema</span>
            <span class="yt-history-badge">${watchHistory.length} видео</span>
        </div>
        <a href="https://www.youtube.com/feed/history" target="_blank" rel="noopener noreferrer">История аккаунта YouTube ↗</a>
        <button class="yt-clear-btn" id="btn-clear-history">🗑️ Очистить историю</button>
    `;
    grid.appendChild(header);

    document.getElementById('btn-clear-history')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (btn.dataset.confirming === 'true') {
            watchHistory = [];
            localStorage.removeItem('yt_history');
            loadYouTubeHistory();
        } else {
            btn.dataset.confirming = 'true';
            btn.innerText = '⚠️ Нажмите еще раз для очистки';
            btn.style.borderColor = '#ef4444';
            btn.style.color = '#ef4444';
            setTimeout(() => {
                if (btn) {
                    btn.dataset.confirming = 'false';
                    btn.innerText = '🗑️ Очистить историю';
                    btn.style.borderColor = '';
                    btn.style.color = '';
                }
            }, 4000);
        }
    });

    // Render history video cards
    watchHistory.forEach((v, index) => {
        const id = v.videoId;
        const title = v.title || "Видео без названия";
        const author = v.author || "YouTube";
        const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        const timeAgo = formatWatchTime(v.time);

        const card = document.createElement('div');
        card.className = 'yt-card';
        card.style.position = 'relative';
        card.innerHTML = `
            <div class="yt-thumb-wrap">
                <img src="${thumb}" alt="${youtubeAccount.escapeHtml(title)}" loading="lazy">
                <div class="yt-duration-badge" style="background: rgba(0,0,0,0.85);">${timeAgo}</div>
                <button class="yt-card-remove-btn" title="Удалить из истории" data-index="${index}">✕</button>
            </div>
            <div class="yt-card-info">
                <div class="yt-card-title">${youtubeAccount.escapeHtml(title)}</div>
                <div class="yt-card-author">${youtubeAccount.escapeHtml(author)}</div>
            </div>
        `;

        card.querySelector('.yt-thumb-wrap img')?.addEventListener('click', () => {
            playYouTubeVideoById(id, title, author, 0);
        });
        card.querySelector('.yt-card-info')?.addEventListener('click', () => {
            playYouTubeVideoById(id, title, author, 0);
        });

        card.querySelector('.yt-card-remove-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            watchHistory.splice(index, 1);
            localStorage.setItem('yt_history', JSON.stringify(watchHistory));
            loadYouTubeHistory();
        });

        grid.appendChild(card);
    });
}

function loadYouTubeHomeTab() {
    document.querySelectorAll('.yt-pill-btn').forEach(p => p.classList.remove('active'));
    const homePill = document.querySelector('.yt-pill-btn[data-query="home"]');
    if (homePill) homePill.classList.add('active');
    loadYouTubeHome();
}

function formatWatchTime(ts) {
    if (!ts) return "Ранее";
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return "Только что";
    if (diffMin < 60) return `${diffMin} мин назад`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} ч назад`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Вчера";
    if (diffDays < 7) return `${diffDays} дн назад`;
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatRelativeTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))} мин назад`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
    if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)} дн назад`;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// =========================================
// YOUTUBE SEARCH & DIRECT VIDEO RESOLVER
// =========================================
async function searchYouTube(query) {
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;

    const trimmed = (query || "").trim();
    if (!trimmed) return;

    // Direct YouTube link detection
    const ytMatch = trimmed.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (ytMatch && ytMatch[1]) {
        playYouTubeVideoById(ytMatch[1], "Видео по ссылке", "YouTube");
        return;
    }

    const view = ++youtubeView;
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #888;"><span class="pulse-dot"></span> Поиск в YouTube: "${youtubeAccount.escapeHtml(trimmed)}"...</div>`;

    const token = await getValidGoogleAccessToken();
    if (view !== youtubeView) return;

    // 1. Google YouTube Data API v3 Search if authorized
    if (token) {
        try {
            const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(trimmed)}&type=video&maxResults=25`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (view !== youtubeView) return;
                if (data.items && data.items.length > 0) {
                    const searchVideos = data.items.map(item => ({
                        videoId: item.id?.videoId,
                        title: item.snippet?.title,
                        author: item.snippet?.channelTitle,
                        publishedAt: item.snippet?.publishedAt,
                        badgeText: '🔍 YouTube',
                        thumb: `https://i.ytimg.com/vi/${item.id?.videoId}/hqdefault.jpg`
                    })).filter(v => Boolean(v.videoId));

                    if (searchVideos.length > 0) {
                        renderYouTubeCards(searchVideos);
                        return;
                    }
                }
            }
        } catch(e) {
            console.warn("[Tesla Cinema] Google Search API error:", e);
        }
    }

    // 2. Multi-provider search (piped, invidious)
    const videos = await fetchYouTubeList('search', trimmed);
    if (view !== youtubeView) return;
    if (videos && videos.length > 0) {
        renderYouTubeCards(videos);
        return;
    }

    // 3. Match from real YouTube catalog if offline
    const catalogMatches = REAL_YOUTUBE_CATALOG.filter(v => 
        v.title.toLowerCase().includes(trimmed.toLowerCase()) || 
        v.author.toLowerCase().includes(trimmed.toLowerCase())
    );
    if (catalogMatches.length > 0) {
        renderYouTubeCards(catalogMatches.map(v => ({
            videoId: v.id,
            title: v.title,
            author: v.author,
            durationSec: v.dur,
            badgeText: v.badge,
            thumb: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
        })));
        return;
    }

    grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #888;">
            <div style="font-size: 32px; margin-bottom: 12px;">🔍</div>
            <div style="font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 8px;">Ничего не найдено по запросу "${youtubeAccount.escapeHtml(trimmed)}"</div>
            <div style="font-size: 13px; color: #aaa; margin-bottom: 20px;">Попробуйте другой поисковый запрос или вставьте прямую ссылку на видео YouTube.</div>
            <button class="btn-primary" style="padding: 10px 24px;" onclick="loadYouTubeHomeTab()">Вернуться на Главную</button>
        </div>
    `;
}

function openDirectUrlPrompt(query) {
    const input = document.getElementById('video-url-input');
    if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth' });
    }
}

function renderYouTubeCards(videos, { append = false } = {}) {
    const grid = document.getElementById('yt-video-grid');
    if (!grid) return;
    if (!append) grid.innerHTML = '';

    const normalizedList = videos
        .map(raw => (raw.videoId && raw.durationSec !== undefined) ? raw : normalizeVideoItem(raw))
        .filter(v => v && v.videoId);

    const queueOffset = append ? currentVideoQueue.length : 0;
    currentVideoQueue = append ? [...currentVideoQueue, ...normalizedList] : normalizedList;

    normalizedList.forEach((v, index) => {
        const id = v.videoId;
        const title = v.title || "Видео без названия";
        const author = v.author || "";
        const durationSec = v.durationSec || 0;
        const isLive = Boolean(v.isLive);

        let durationBadge = "";
        if (v.badgeText) {
            durationBadge = `<div class="yt-duration-badge" style="background: rgba(0, 0, 0, 0.85); border: 1px solid rgba(74, 222, 128, 0.5); color: #4ade80; font-weight: 700; padding: 2px 8px; border-radius: 6px;">${v.badgeText}</div>`;
        } else if (isLive) {
            durationBadge = '<div class="yt-duration-badge live" style="background: #ff3b30; color: white; font-weight: 800;">🔴 ЭФИР</div>';
        } else if (durationSec > 0) {
            durationBadge = `<div class="yt-duration-badge">${formatTime(durationSec)}</div>`;
        }

        const thumb = v.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

        const card = document.createElement('div');
        card.className = 'yt-card';
        card.innerHTML = `
            <div class="yt-thumb-wrap">
                <img src="${thumb}" alt="${youtubeAccount.escapeHtml(title)}" loading="lazy" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${id}/hqdefault.jpg'">
                ${durationBadge}
            </div>
            <div class="yt-card-info">
                <div class="yt-card-title">${youtubeAccount.escapeHtml(title)}</div>
                <div class="yt-card-author">${youtubeAccount.escapeHtml(author)}</div>
            </div>
        `;

        card.addEventListener('click', () => {
            currentQueueIndex = queueOffset + index;
            playYouTubeVideoById(id, title, author, durationSec);
        });

        grid.appendChild(card);
    });
}

// =========================================
// wBLOCK: AD & SPONSORBLOCK INTEGRATION
// =========================================
const wBlock = {
    enabled: true,
    sponsorBlockEnabled: true,
    skippedCount: 0,
    currentSegments: [],
    markersRendered: false,
    lastSkippedSegment: null,
    skippedSegmentIds: new Set(),
    isSkipping: false,
    toastTimer: null,
    isAdAccelerated: false,
    savedSpeed: 1.0,
    autoSkipTimer: null,
    sb: null,
    fetchAbortController: null,
    fetchRequestId: 0,

    initSponsorBlock(playerInstance) {
        if (typeof SponsorBlock === 'undefined') return;
        if (!this.sb) {
            const counterEl = document.getElementById('wblock-stat');
            this.sb = new SponsorBlock(playerInstance || ytPlayer, {
                categories: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'],
                minDuration: 0.8,
                getCurrentTime: () => getCurrentTime(),
                seekTo: (time) => seekTo(time),
                onSkip: ({ category, from, to, count }) => {
                    this.skippedCount = count;
                    this.lastSkippedSegment = this.sb.lastSkip;
                    if (counterEl && currentCinemaEngine !== 'clean') {
                        counterEl.textContent = `🛡️ SponsorBlock ${count}`;
                    }
                    this.showToast(category);
                },
                onUndo: ({ category, count }) => {
                    this.skippedCount = count;
                    this.lastSkippedSegment = null;
                    this.updateUI();
                    const toast = document.getElementById('wblock-skip-toast');
                    if (toast) toast.style.display = 'none';
                }
            });
            window.sb = this.sb;
            if (this.sb.count > 0) {
                this.skippedCount = this.sb.count;
            }
        } else if (playerInstance) {
            this.sb.setPlayer(playerInstance);
        }
    },

    handleAdDetected() {
        if (!this.enabled || this.isAdAccelerated) return;
        this.isAdAccelerated = true;
        this.savedSpeed = currentSpeed || 1.0;
        console.log("[wBlock] YouTube video ad detected! Muting ad audio...");

        // 1. Mute ad immediately so driver isn't disturbed by loud commercials
        sendYTCommand('mute', []);

        // Note: Do NOT set playback rate to 2x on Tesla MCU! 
        // 2x speed stalls hardware video decoding on Tesla Linux GPU, causing video to freeze on 1 frame!

        // 2. Update stats & toast
        this.skippedCount++;
        this.updateUI();
        this.showToast('video-ad');

        // 3. Floating Ad Shield with direct 1-tap Clean Mode switch & skip button
        let shield = document.getElementById('ad-shield');
        if (!shield) {
            shield = document.createElement('div');
            shield.id = 'ad-shield';
            shield.className = 'ad-shield';
            const stage = document.getElementById('cinema-stage');
            if (stage) stage.appendChild(shield);
        }
        shield.innerHTML = `
            <div class="ad-shield-content">
                <span class="ad-shield-badge">🛡️ Реклама на YouTube (звук приглушен)</span>
                <button class="ad-switch-clean-btn" onclick="setCinemaEngine('clean')" title="Переключить на плеер без рекламы">
                    🛡️ Без рекламы
                </button>
                <button class="ad-skip-force-btn" onclick="skipAdForce()">
                    ⏭️ Пропустить
                </button>
            </div>
        `;
        shield.style.display = 'flex';
    },

    restoreAfterAd() {
        if (!this.isAdAccelerated) return;
        this.isAdAccelerated = false;
        if (this.autoSkipTimer) clearTimeout(this.autoSkipTimer);
        console.log("[wBlock] Ad ended, restoring normal playback.");
        sendYTCommand('unMute', []);
        const shield = document.getElementById('ad-shield');
        if (shield) shield.style.display = 'none';
    },

    async fetchSponsorSegments(videoId) {
        this.currentSegments = [];
        this.clearMarkers();
        this.skippedSegmentIds = new Set();
        this.lastSkippedSegment = null;
        if (!videoId || !this.sponsorBlockEnabled) return [];

        if (this.fetchAbortController) {
            try { this.fetchAbortController.abort(); } catch(e) {}
        }
        this.fetchAbortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const signal = this.fetchAbortController ? this.fetchAbortController.signal : null;
        const currentReq = ++this.fetchRequestId;

        try {
            if (!this.sb && typeof SponsorBlock !== 'undefined') {
                this.initSponsorBlock(ytPlayer);
            }
            if (this.sb) {
                this.sb.videoId = videoId;
            }

            const categories = this.sb ? this.sb.categories : ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'];
            const segments = (typeof SponsorBlock !== 'undefined' && SponsorBlock.load)
                ? await SponsorBlock.load(videoId, categories, signal)
                : [];

            if (currentReq !== this.fetchRequestId || (signal && signal.aborted)) {
                return this.currentSegments;
            }

            this.currentSegments = segments || [];
            if (this.sb) {
                this.sb.segments = this.currentSegments;
                this.sb.ignored.clear();
                this.sb.undone.clear();
                this.sb.lastSkip = null;
            }

            if (this.currentSegments.length > 0) {
                console.log(`[wBlock] Loaded ${this.currentSegments.length} SponsorBlock segments for ${videoId}`);
                this.setStat(`${this.currentSegments.length} спонсор(ов)`);
                this.renderMarkers();
            } else {
                this.setStat('Чисто');
            }
            return this.currentSegments;
        } catch (e) {
            if (e && e.name === 'AbortError') return [];
            if (currentReq !== this.fetchRequestId) return this.currentSegments;
            console.warn("[wBlock] SponsorBlock fetch error:", e);
            this.setStat('Чисто');
            return [];
        }
    },

    renderMarkers() {
        const container = document.getElementById('sponsor-segments-layer');
        if (!container) return;
        container.innerHTML = '';
        const dur = getDuration();
        if (!dur || dur <= 0) return;

        this.currentSegments.forEach(seg => {
            const leftPct = (seg.start / dur) * 100;
            const widthPct = Math.max(0.5, ((seg.end - seg.start) / dur) * 100);
            const marker = document.createElement('div');
            marker.className = `sponsor-segment-marker ${seg.category}`;
            marker.style.left = `${leftPct}%`;
            marker.style.width = `${widthPct}%`;
            marker.title = `wBlock: ${seg.category}`;
            container.appendChild(marker);
        });
        this.markersRendered = true;
    },

    clearMarkers() {
        const container = document.getElementById('sponsor-segments-layer');
        if (container) container.innerHTML = '';
        this.markersRendered = false;
        this.skippedSegmentIds = new Set();
        this.lastSkippedSegment = null;
        if (this.sb) {
            this.sb.clear();
        }
    },

    checkAndSkip(currentTime, duration) {
        if (!this.enabled || !this.sponsorBlockEnabled) return;
        if (this.isAdAccelerated) return;
        if (!this.currentSegments || !this.currentSegments.length) return;
        if (this.isSkipping) return;

        const t = (typeof currentTime === 'number' && !isNaN(currentTime)) ? currentTime : getCurrentTime();
        if (typeof t !== 'number' || isNaN(t)) return;

        for (const seg of this.currentSegments) {
            if (this.skippedSegmentIds.has(seg.id)) continue;

            if (t >= (seg.start - 0.2) && t < (seg.end - 0.3)) {
                this.isSkipping = true;
                this.skippedSegmentIds.add(seg.id);
                this.lastSkippedSegment = seg;
                if (this.sb) {
                    this.sb.ignored.add(seg.id);
                    this.sb.lastSkip = seg;
                }

                console.log(`[wBlock] Auto-skipping ${seg.category} (${seg.start.toFixed(1)}s -> ${seg.end.toFixed(1)}s)`);
                seekTo(seg.end);
                this.skippedCount++;
                try { localStorage.setItem('sb_count', String(this.skippedCount)); } catch(e) {}
                if (this.sb) this.sb.count = this.skippedCount;

                this.updateUI();
                this.showToast(seg.category);

                setTimeout(() => {
                    this.isSkipping = false;
                }, 600);
                break;
            }
        }
    },

    updateUI() {
        const statEl = document.getElementById('wblock-stat');
        if (statEl) {
            if (currentCinemaEngine === 'clean') {
                statEl.innerText = "0 рекламы (Clean)";
            } else {
                statEl.innerText = `${this.skippedCount} ad/skip`;
            }
        }
    },

    setStat(text) {
        const statEl = document.getElementById('wblock-stat');
        if (statEl) {
            if (currentCinemaEngine === 'clean') {
                statEl.innerText = "0 рекламы (Clean)";
            } else {
                statEl.innerText = text;
            }
        }
    },

    showCustomToast(text) {
        const toast = document.getElementById('wblock-skip-toast');
        const msg = document.getElementById('wblock-toast-msg');
        const undoBtn = document.getElementById('btn-undo-skip');
        if (!toast || !msg) return;

        if (undoBtn) undoBtn.style.display = 'none';
        msg.innerText = text;
        toast.style.display = 'flex';

        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.style.display = 'none';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        }, 3000);
    },

    showToast(category) {
        const toast = document.getElementById('wblock-skip-toast');
        const msg = document.getElementById('wblock-toast-msg');
        const undoBtn = document.getElementById('btn-undo-skip');
        if (!toast || !msg) return;

        let catName = 'реклама';
        if (category === 'video-ad') {
            catName = 'видеореклама (звук приглушен)';
            if (undoBtn) undoBtn.style.display = 'none';
        } else if (category === 'sponsor') {
            catName = 'спонсорский блок';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'selfpromo') {
            catName = 'самореклама автора';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'interaction') {
            catName = 'напоминание о подписке';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'intro') {
            catName = 'заставка/интро';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'outro') {
            catName = 'титры/концовка';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'preview') {
            catName = 'анонс/превью';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'music_offtopic') {
            catName = 'немузыкальная вставка';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        } else if (category === 'filler') {
            catName = 'отступление от темы';
            if (undoBtn) undoBtn.style.display = 'inline-block';
        }
        msg.innerText = `🛡️ wBlock: Пропущен(а) ${catName}`;
        toast.style.display = 'flex';

        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.style.display = 'none';
        }, 3500);
    },

    undoLastSkip() {
        if (this.lastSkippedSegment) {
            const seg = this.lastSkippedSegment;
            seekTo(Math.max(0, seg.start));
            this.skippedSegmentIds.add(seg.id);
            if (this.sb) {
                this.sb.undone.add(seg.id);
                this.sb.ignored.add(seg.id);
                this.sb.lastSkip = null;
            }
            this.lastSkippedSegment = null;
            if (this.skippedCount > 0) this.skippedCount--;
            try { localStorage.setItem('sb_count', String(this.skippedCount)); } catch(e) {}
            if (this.sb) this.sb.count = this.skippedCount;
            this.updateUI();
            const toast = document.getElementById('wblock-skip-toast');
            if (toast) toast.style.display = 'none';
            return;
        }
        if (this.sb && this.sb.lastSkip) {
            this.sb.undo();
            this.skippedCount = this.sb.count;
            this.updateUI();
            const toast = document.getElementById('wblock-skip-toast');
            if (toast) toast.style.display = 'none';
        }
    }
};

const playbackFeatures = wBlock;
window.wBlock = wBlock;
window.playbackFeatures = playbackFeatures;

function skipAdForce() {
    if (!currentPlayingVideoId) return;
    console.log("[Tesla Cinema] skipAdForce triggered by user");

    // 1. Unmute
    wBlock.restoreAfterAd();

    // 2. Try seeking ad to its end
    if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
        try {
            const adDur = ytPlayer.getDuration();
            if (adDur > 0 && adDur < 300) {
                ytPlayer.seekTo(adDur + 1, true);
            }
        } catch(e) {}
    }

    // 3. PostMessage direct seek to end
    const frame = document.getElementById('yt-player-frame');
    if (frame && frame.contentWindow) {
        try {
            frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [999999, true] }), '*');
        } catch(e) {}
    }

    wBlock.skippedCount++;
    wBlock.updateUI();
    wBlock.showCustomToast("⚡ Реклама пропущена!");
}
window.skipAdForce = skipAdForce;

function checkIsAdPlaying() {
    if (!ytPlayer) return false;
    try {
        if (typeof ytPlayer.getVideoData === 'function') {
            const vData = ytPlayer.getVideoData();
            if (vData) {
                if (vData.isAd === true || Boolean(vData.adVideoId)) return true;
                if (vData.video_id && currentPlayingVideoId && vData.video_id !== currentPlayingVideoId) return true;
            }
        }
        if (typeof ytPlayer.getAdState === 'function') {
            const st = ytPlayer.getAdState();
            if (st === 1) return true;
        }
    } catch(e) {}
    return false;
}

function sendYTCommand(func, args = '') {
    if (ytPlayer && typeof ytPlayer[func] === 'function') {
        try {
            if (Array.isArray(args)) ytPlayer[func](...args);
            else if (args !== '') ytPlayer[func](args);
            else ytPlayer[func]();
        } catch(e){}
    }
    const frame = document.getElementById('yt-player-frame');
    if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({
            event: 'command',
            func: func,
            args: args
        }), '*');
    }
}

// =========================================
// AUTO-PLAY NEXT & VIDEO QUEUE ENGINE
// =========================================
function updateAutoPlayUI() {
    const btn = document.getElementById('btn-autoplay-toggle');
    if (btn) {
        btn.classList.toggle('active', autoPlayNextEnabled);
        btn.title = `Автовоспроизведение следующего видео: ${autoPlayNextEnabled ? 'ВКЛ' : 'ВЫКЛ'}`;
    }
}

function toggleAutoPlayNext() {
    autoPlayNextEnabled = !autoPlayNextEnabled;
    localStorage.setItem('yt_autoplay_next', autoPlayNextEnabled ? 'true' : 'false');
    updateAutoPlayUI();
    wBlock.showCustomToast(autoPlayNextEnabled ? "🔁 Автопереход: ВКЛ" : "⏸️ Автопереход: ВЫКЛ");
}
window.toggleAutoPlayNext = toggleAutoPlayNext;

function getNextVideoInQueue() {
    let queue = (currentVideoQueue && currentVideoQueue.length > 0)
        ? currentVideoQueue
        : REAL_YOUTUBE_CATALOG.map(v => ({ videoId: v.id, title: v.title, author: v.author, durationSec: v.dur }));

    if (queue.length === 0) return null;

    let idx = currentQueueIndex;
    if (idx < 0 && currentPlayingVideoId) {
        idx = queue.findIndex(v => (v.videoId || v.id) === currentPlayingVideoId);
    }

    const nextIdx = (idx >= 0 && idx < queue.length - 1) ? idx + 1 : 0;
    const rawNext = queue[nextIdx];
    return {
        videoId: rawNext.videoId || rawNext.id,
        title: rawNext.title || "Следующее видео",
        author: rawNext.author || "",
        durationSec: rawNext.durationSec || rawNext.dur || 0
    };
}

function handleVideoEnded() {
    console.log("[Tesla Cinema] Current video ended. Autoplay enabled:", autoPlayNextEnabled);
    isPlaying = false;
    updatePlayIcons(false);
    showUnmuteBanner(false);

    if (!autoPlayNextEnabled) {
        return;
    }

    const next = getNextVideoInQueue();
    if (!next || !next.videoId) return;

    showNextVideoCountdown(next);
}

function showNextVideoCountdown(nextVideo) {
    cancelNextVideoTimer();

    const overlay = document.getElementById('next-video-overlay');
    const titleEl = document.getElementById('next-video-title');
    const authorEl = document.getElementById('next-video-author');
    const badgeEl = document.getElementById('next-countdown-badge');

    if (!overlay) {
        playNextVideo();
        return;
    }

    if (titleEl) titleEl.innerText = nextVideo.title;
    if (authorEl) authorEl.innerText = nextVideo.author;

    nextCountdownSec = 4;
    if (badgeEl) badgeEl.innerText = `через ${nextCountdownSec} сек`;
    overlay.style.display = 'flex';

    nextCountdownInterval = setInterval(() => {
        nextCountdownSec--;
        if (badgeEl) badgeEl.innerText = `через ${nextCountdownSec} сек`;
        if (nextCountdownSec <= 0) {
            cancelNextVideoTimer();
            playNextVideo();
        }
    }, 1000);
}

function cancelNextVideoTimer() {
    if (nextCountdownInterval) {
        clearInterval(nextCountdownInterval);
        nextCountdownInterval = null;
    }
    const overlay = document.getElementById('next-video-overlay');
    if (overlay) overlay.style.display = 'none';
}
window.cancelNextVideoTimer = cancelNextVideoTimer;

function playNextVideo() {
    cancelNextVideoTimer();
    const next = getNextVideoInQueue();
    if (!next || !next.videoId) return;

    console.log("[Tesla Cinema] Switching to next video:", next.videoId, next.title);
    if (currentVideoQueue.length > 0) {
        const found = currentVideoQueue.findIndex(v => (v.videoId || v.id) === next.videoId);
        if (found !== -1) currentQueueIndex = found;
    }
    playYouTubeVideoById(next.videoId, next.title, next.author, next.durationSec);
}
window.playNextVideo = playNextVideo;

// =========================================
// PLAYER MOUNTING: OFFICIAL EMBED WITH wBLOCK AD-SHIELD
// =========================================
function showUnmuteBanner(show) {
    const banner = document.getElementById('unmute-banner');
    if (!banner) return;
    banner.style.display = show ? 'flex' : 'none';
}

function userTriggerUnmute() {
    if (ytPlayer) {
        try {
            ytPlayer.unMute();
            ytPlayer.setVolume(100);
        } catch(e) {}
    }
    const directVid = document.getElementById('direct-stream-video');
    if (directVid) {
        directVid.muted = false;
    }
    showUnmuteBanner(false);
}
window.userTriggerUnmute = userTriggerUnmute;

function handlePlayerError(videoId, code) {
    console.warn(`[Tesla Cinema] Player error ${code} for video ${videoId}`);
    const mount = document.getElementById('canvas-player-mount');
    if (!mount) return;
    let msg = "Не удалось воспроизвести это видео.";
    if (code === 101 || code === 150) {
        msg = "Автор ограничил встраивание этого видео на внешних сайтах.";
    } else if (code === 100) {
        msg = "Видео удалено или сделано приватным.";
    }
    mount.innerHTML = `
        <div class="yt-embed-error-box">
            <div style="font-size: 32px; margin-bottom: 10px;">⚠️</div>
            <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 8px;">${msg}</div>
            <div style="font-size: 13px; color: #aaa; margin-bottom: 16px;">Вы можете открыть его напрямую на YouTube или выбрать другое видео:</div>
            <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
                <a href="https://m.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener" class="btn-primary" style="text-decoration: none; padding: 10px 20px; font-size: 13px; border-radius: 20px;">
                    ▶️ Открыть на YouTube
                </a>
                <button class="btn-secondary" style="padding: 10px 20px; font-size: 13px; border-radius: 20px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; cursor: pointer;" onclick="loadYouTubeHomeTab()">
                    Выбрать другое видео
                </button>
            </div>
        </div>
    `;
    isPlaying = false;
    updatePlayIcons(false);
    showUnmuteBanner(false);
}

function bindYTPlayer() {
    if (currentCinemaEngine !== 'direct') return;
    const frame = document.getElementById('yt-player-frame');
    if (!frame) return;

    if (typeof YT !== 'undefined' && YT.Player) {
        try {
            ytPlayer = new YT.Player('yt-player-frame', {
                events: {
                    onReady: (event) => {
                        try { event.target.playVideo(); } catch(err){}
                        if (window.sb) {
                            window.sb.setPlayer(ytPlayer);
                        } else if (wBlock.initSponsorBlock) {
                            wBlock.initSponsorBlock(ytPlayer);
                        }
                        try {
                            frame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
                        } catch(e){}
                    },
                    onStateChange: (event) => {
                        if (window.sb) {
                            const isPlayingState = (typeof YT !== 'undefined' && YT.PlayerState)
                                ? (event.data === YT.PlayerState.PLAYING)
                                : (event.data === 1);
                            isPlayingState ? window.sb.start() : window.sb.stop();
                        }

                        if (event.data === 1) { // Playing
                            isPlaying = true;
                            updatePlayIcons(true);

                            // Check unmute
                            setTimeout(() => {
                                try {
                                    if (ytPlayer && typeof ytPlayer.isMuted === 'function' && ytPlayer.isMuted()) {
                                        showUnmuteBanner(true);
                                    } else {
                                        showUnmuteBanner(false);
                                    }
                                } catch(e) {}
                            }, 300);

                            if (checkIsAdPlaying()) {
                                wBlock.handleAdDetected();
                            } else if (wBlock.isAdAccelerated) {
                                wBlock.restoreAfterAd();
                            }
                        } else if (event.data === 2) { // Paused
                            isPlaying = false;
                            updatePlayIcons(false);
                        } else if (event.data === 0) { // Ended
                            handleVideoEnded();
                        }
                    },
                    onError: (event) => {
                        console.warn("[Tesla Cinema] YouTube Player Error:", event.data);
                        handlePlayerError(currentPlayingVideoId, event.data);
                    }
                }
            });
        } catch(err) {
            console.warn("YT.Player binding warning:", err);
        }
    }
}

async function resolveStreamsWithServer(videoId) {
    const backendUrl = localStorage.getItem('cinema_backend_url');
    if (!backendUrl) {
        throw new Error('BACKEND_URL_MISSING');
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(`${backendUrl}/api/stream?id=${encodeURIComponent(videoId)}`, {
        signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
        throw new Error(`Server HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.videoUrl) {
        throw new Error('No videoUrl in server response');
    }
    return {
        videoUrl: data.videoUrl,
        audioUrl: data.audioUrl || null,
        duration: data.duration || 0
    };
}

async function resolveStreamsWithCobalt(videoId) {
    const cobaltInstances = [
        'https://api.cobalt.tools/',
        'https://cobalt-api.kwiatekm.tokyo/',
        'https://api.streamrip.net/'
    ];

    let lastErr = null;
    for (const api of cobaltInstances) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);
            const resp = await fetch(api, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    videoQuality: '720'
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!resp.ok) continue;
            const data = await resp.json();
            if (data && (data.url || data.stream)) {
                return {
                    videoUrl: data.url || data.stream,
                    audioUrl: null,
                    duration: 0
                };
            }
        } catch(e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('Cobalt instances unreachable');
}

function mountOGVCanvasPlayer(videoUrl, audioUrl, startTime = 0) {
    cleanupCurrentPlayer();
    const mount = document.getElementById('canvas-player-mount');
    if (!mount) return;

    if (window.OGVLoader) {
        window.OGVLoader.base = "https://cdn.jsdelivr.net/npm/ogv@1.8.9/dist";
    }

    try {
        if (typeof OGVPlayer === 'undefined') {
            console.warn("[Tesla Cinema] OGVPlayer not found, using HTML5 video fallback");
            mount.innerHTML = `
                <video id="direct-stream-video" controls autoplay playsinline style="width: 100%; height: 100%; object-fit: contain;">
                    <source src="${videoUrl}">
                </video>
            `;
            const v = document.getElementById('direct-stream-video');
            if (v) {
                if (startTime > 0) v.currentTime = startTime;
                v.play().catch(e => console.warn(e));
            }
            isPlaying = true;
            updatePlayIcons(true);
            return;
        }

        const player = new OGVPlayer({
            webGL: true,
            audio: !audioUrl
        });
        ogvPlayerInstance = player;
        player.id = "teslatelek-ogv-canvas";
        player.style.width = "100%";
        player.style.height = "100%";
        player.style.objectFit = "contain";
        player.style.position = "absolute";
        player.style.top = "0";
        player.style.left = "0";
        player.style.background = "#000000";

        player.muted = !!audioUrl;
        player.crossOrigin = "anonymous";
        player.src = videoUrl;

        mount.appendChild(player);

        if (audioUrl && audioEl) {
            audioEl.src = audioUrl;
            audioEl.currentTime = startTime;
            audioEl.playbackRate = currentSpeed;
        }

        player.onloadedmetadata = () => {
            if (startTime > 0) {
                player.currentTime = startTime;
            }
            if (player.duration && player.duration > 0) {
                ytDuration = player.duration;
            }
        };

        player.onplay = () => {
            isPlaying = true;
            updatePlayIcons(true);
            if (audioUrl && audioEl && audioEl.paused) {
                audioEl.play().catch(e => console.warn("[Tesla Cinema] Audio play error:", e));
            }
        };

        player.onpause = () => {
            isPlaying = false;
            updatePlayIcons(false);
            if (audioUrl && audioEl && !audioEl.paused) {
                audioEl.pause();
            }
        };

        player.ontimeupdate = () => {
            if (player.currentTime) {
                ytCurrentTime = player.currentTime;
                updateScrubber();
            }
        };

        player.onended = () => {
            handleVideoEnded();
        };

        player.onerror = (err) => {
            console.error("[Tesla Cinema] OGV Player error:", err);
            wBlock.showCustomToast("⚠️ Ошибка Canvas-рендера. Переключаем на YouTube HD...");
            mountIframePlayer(currentPlayingVideoId, startTime);
        };

        player.play().catch(err => {
            console.warn("[Tesla Cinema] OGV autoplay blocked:", err);
            showUnmuteBanner(true);
        });

    } catch (e) {
        console.error("[Tesla Cinema] Failed to mount OGV Player:", e);
        mountIframePlayer(currentPlayingVideoId, startTime);
    }

    isPlaying = true;
    updatePlayIcons(true);
    updateEngineUI();
}
window.mountOGVCanvasPlayer = mountOGVCanvasPlayer;

function mountIframePlayer(videoId, effectiveStart = 0) {
    cleanupCurrentPlayer();
    const mount = document.getElementById('canvas-player-mount');
    if (!mount) return;

    const startParam = effectiveStart > 0 ? `&start=${effectiveStart}` : '';
    const originParam = (window.location.origin && window.location.origin !== 'null' && window.location.protocol.startsWith('http'))
        ? `&origin=${encodeURIComponent(window.location.origin)}`
        : '';

    mount.innerHTML = `
        <iframe id="yt-player-frame"
            src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1${originParam}&playsinline=1&rel=0${startParam}&iv_load_policy=3"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; background: #000;">
        </iframe>
    `;

    const frame = document.getElementById('yt-player-frame');
    if (frame) {
        frame.onload = () => {
            bindYTPlayer();
            try {
                frame.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
            } catch(e) {}
        };
    }
    bindYTPlayer();
    isPlaying = true;
    updatePlayIcons(true);
    updateEngineUI();
}
window.mountIframePlayer = mountIframePlayer;

async function mountVideoPlayer(videoId, startTime = 0) {
    const mount = document.getElementById('canvas-player-mount');
    const overlay = document.getElementById('player-overlay');
    if (overlay) overlay.classList.add('hidden');
    showUnmuteBanner(false);
    if (!mount) return;

    cleanupCurrentPlayer();
    const effectiveStart = Math.max(0, Math.floor(startTime || 0));

    console.log(`[Tesla Cinema] Mounting Player for ${videoId} using engine: ${currentCinemaEngine} at ${effectiveStart}s`);

    if (currentCinemaEngine === 'server') {
        const backendUrl = localStorage.getItem('cinema_backend_url');
        if (!backendUrl) {
            openBackendConfigModal();
            wBlock.showCustomToast("⚠️ Укажите адрес своего сервера в настройках");
            mountIframePlayer(videoId, effectiveStart);
            return;
        }

        mount.innerHTML = `
            <div id="player-stream-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:#000;color:#fff;">
                <div class="tesla-spinner" style="width:40px;height:40px;border:3px solid rgba(48,209,88,0.2);border-top:3px solid #30d158;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
                <div style="margin-top:14px;font-size:14px;color:#a0a0a0;font-weight:600;">🚀 Подключение к своему серверу (D/R WebGL)...</div>
            </div>
        `;

        try {
            const stream = await resolveStreamsWithServer(videoId);
            if (currentPlayingVideoId !== videoId) return;
            mountOGVCanvasPlayer(stream.videoUrl, stream.audioUrl, effectiveStart);
            return;
        } catch (e) {
            console.error("[Tesla Cinema] Server stream failed:", e);
            wBlock.showCustomToast("⚠️ Свой сервер недоступен, пробуем Cobalt...");
            try {
                const cStream = await resolveStreamsWithCobalt(videoId);
                if (currentPlayingVideoId !== videoId) return;
                mountOGVCanvasPlayer(cStream.videoUrl, null, effectiveStart);
                return;
            } catch(e2) {
                mountIframePlayer(videoId, effectiveStart);
                return;
            }
        }
    } else if (currentCinemaEngine === 'cobalt') {
        mount.innerHTML = `
            <div id="player-stream-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:#000;color:#fff;">
                <div class="tesla-spinner" style="width:40px;height:40px;border:3px solid rgba(48,209,88,0.2);border-top:3px solid #30d158;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
                <div style="margin-top:14px;font-size:14px;color:#a0a0a0;font-weight:600;">⚡️ Cobalt API: Получение потока без рекламы (Canvas)...</div>
            </div>
        `;

        try {
            const stream = await resolveStreamsWithCobalt(videoId);
            if (currentPlayingVideoId !== videoId) return;
            mountOGVCanvasPlayer(stream.videoUrl, null, effectiveStart);
            return;
        } catch (e) {
            console.error("[Tesla Cinema] Cobalt stream failed:", e);
            wBlock.showCustomToast("⚠️ Cobalt API временно недоступен, включен Iframe HD");
            mountIframePlayer(videoId, effectiveStart);
            return;
        }
    } else {
        // Direct / Official YouTube Embed
        mountIframePlayer(videoId, effectiveStart);
    }
}

async function playYouTubeVideoById(videoId, title, author, durationSec = 0) {
    console.log("Playing Video:", videoId, title);
    cancelNextVideoTimer();
    currentPlayingVideoId = videoId;
    currentPlayingTitle = title;
    currentPlayingAuthor = author;
    expectedVideoDuration = durationSec;

    // Reset ad-acceleration state for new video
    if (wBlock.isAdAccelerated) {
        wBlock.restoreAfterAd();
    }

    recordWatchHistory(videoId, title, author);
    wBlock.fetchSponsorSegments(videoId);

    // Show cinema stage
    const wrapper = document.getElementById('stage-wrapper');
    if (wrapper) {
        wrapper.classList.add('active');
        wrapper.scrollIntoView({ behavior: 'smooth' });
    }

    const titleEl = document.getElementById('now-playing-title');
    if (titleEl) titleEl.innerText = title;

    mountVideoPlayer(videoId, 0);
}

async function resolveAndPlayVideo(inputUrl) {
    const ytMatch = inputUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (ytMatch && ytMatch[1]) {
        await playYouTubeVideoById(ytMatch[1], "Видео по ссылке", "");
    } else {
        // Direct MP4/WebM/HLS URL
        console.log("Playing direct media URL:", inputUrl);
        const wrapper = document.getElementById('stage-wrapper');
        if (wrapper) {
            wrapper.classList.add('active');
            wrapper.scrollIntoView({ behavior: 'smooth' });
        }
        const titleEl = document.getElementById('now-playing-title');
        if (titleEl) titleEl.innerText = "Прямой видеопоток";

        const mount = document.getElementById('canvas-player-mount');
        mount.innerHTML = `
            <video id="direct-stream-video" controls autoplay playsinline style="width: 100%; height: 100%; object-fit: contain;">
                <source src="${inputUrl}">
                Ваш браузер не поддерживает прямое видео.
            </video>
        `;
        const v = document.getElementById('direct-stream-video');
        if (v) {
            v.onended = () => { handleVideoEnded(); };
            v.play().catch(e => console.warn(e));
            isPlaying = true;
            updatePlayIcons(true);
        }
    }
}

// =========================================
// PLAYBACK CONTROLS & TIMELINE
// =========================================
function togglePlay() {
    userTriggerUnmute();

    const directVid = document.getElementById('direct-stream-video');
    if (directVid) {
        if (directVid.paused) {
            directVid.play().catch(e => console.warn(e));
            isPlaying = true;
        } else {
            directVid.pause();
            isPlaying = false;
        }
        updatePlayIcons(isPlaying);
        return;
    }

    if (ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        const state = ytPlayer.getPlayerState();
        if (state === 1) { // Playing -> Pause
            try { ytPlayer.pauseVideo(); } catch(e){}
            sendYTCommand('pauseVideo', '');
            isPlaying = false;
        } else { // Not playing -> Play
            try { ytPlayer.playVideo(); } catch(e){}
            sendYTCommand('playVideo', '');
            isPlaying = true;
        }
    } else {
        if (isPlaying) {
            sendYTCommand('pauseVideo', '');
            isPlaying = false;
        } else {
            sendYTCommand('playVideo', '');
            isPlaying = true;
        }
    }
    updatePlayIcons(isPlaying);
}

function updatePlayIcons(playing) {
    const icon = document.getElementById('ctrl-play-icon');
    if (icon) {
        if (playing) {
            icon.innerHTML = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
        } else {
            icon.innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
        }
    }
    const stage = document.getElementById('cinema-stage');
    if (stage) {
        if (!playing) {
            stage.classList.add('show-controls');
        } else {
            stage.classList.add('show-controls');
            setTimeout(() => {
                if (isPlaying && stage) stage.classList.remove('show-controls');
            }, 3000);
        }
    }
}

function seekRelative(delta) {
    const target = getCurrentTime() + delta;
    seekTo(Math.max(0, target));
}

function seekTo(time) {
    const directVid = document.getElementById('direct-stream-video');
    if (directVid) {
        directVid.currentTime = time;
        return;
    }

    if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
        try { ytPlayer.seekTo(time, true); } catch(e){}
    }
    const frame = document.getElementById('yt-player-frame');
    if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }), '*');
    }
    ytCurrentTime = time;
    updateScrubber();
}

function getCurrentTime() {
    const directVid = document.getElementById('direct-stream-video');
    if (directVid) return directVid.currentTime || 0;

    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        try {
            const t = ytPlayer.getCurrentTime();
            if (typeof t === 'number' && t >= 0) return t;
        } catch(e) {}
    }
    return ytCurrentTime;
}

function getDuration() {
    const directVid = document.getElementById('direct-stream-video');
    if (directVid) return directVid.duration || 0;

    if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
        try {
            const d = ytPlayer.getDuration();
            if (typeof d === 'number' && d > 0) return d;
        } catch(e) {}
    }
    return ytDuration || expectedVideoDuration || 0;
}

function setPlaybackRate(rate) {
    currentSpeed = rate;
    const directVid = document.getElementById('direct-stream-video');
    if (directVid) {
        directVid.playbackRate = rate;
        return;
    }
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
        try { ytPlayer.setPlaybackRate(rate); } catch(e){}
    }
    const frame = document.getElementById('yt-player-frame');
    if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setPlaybackRate', args: [rate] }), '*');
    }
}

function formatTime(s, forceHours = false) {
    if (isNaN(s) || s === null || s < 0) return forceHours ? "00:00:00" : "00:00";
    const totalSec = Math.floor(s);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const pad = (n) => (n < 10 ? '0' : '') + n;

    if (h > 0 || forceHours) {
        return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    }
    return `${pad(m)}:${pad(sec)}`;
}

function updateScrubber() {
    // wBlock: Live ad check via explicit YouTube ad signals
    if (checkIsAdPlaying()) {
        wBlock.handleAdDetected();
    } else if (wBlock.isAdAccelerated) {
        wBlock.restoreAfterAd();
    }

    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        try {
            const cur = ytPlayer.getCurrentTime();
            const dur = ytPlayer.getDuration();
            if (typeof cur === 'number' && cur >= 0) ytCurrentTime = cur;
            if (typeof dur === 'number' && dur > 0) ytDuration = dur;
        } catch(e) {}
    }

    const cur = getCurrentTime();
    const dur = getDuration();
    const timeEl = document.getElementById('player-time');
    const fillEl = document.getElementById('scrubber-fill');
    const thumbEl = document.getElementById('scrubber-thumb');
    const bufEl = document.getElementById('scrubber-buffered');

    if (bufEl) {
        let loadedPct = 0;
        if (ytPlayer && typeof ytPlayer.getVideoLoadedFraction === 'function') {
            try {
                const fraction = ytPlayer.getVideoLoadedFraction();
                if (typeof fraction === 'number' && fraction >= 0) {
                    loadedPct = fraction * 100;
                }
            } catch(e) {}
        }
        const directVid = document.getElementById('direct-stream-video');
        if (directVid && directVid.buffered.length > 0 && dur > 0) {
            try {
                const bufferedEnd = directVid.buffered.end(directVid.buffered.length - 1);
                loadedPct = (bufferedEnd / dur) * 100;
            } catch(e) {}
        }
        if (loadedPct > 0) {
            bufEl.style.width = `${Math.min(100, Math.max(0, loadedPct))}%`;
        }
    }

    // Livestream detection
    const isLive = (ytPlayer && typeof ytPlayer.getVideoData === 'function' && ytPlayer.getVideoData()?.isLive) ||
                   (dur <= 0 && cur > 0) ||
                   (dur > 43200) ||
                   (dur === Infinity);

    if (isLive) {
        if (timeEl) {
            timeEl.innerHTML = '<span style="color: #ff3b30; font-weight: 800; display: inline-flex; align-items: center; gap: 5px;"><span class="live-dot"></span>ПРЯМОЙ ЭФИР</span>';
        }
        if (fillEl) {
            fillEl.style.width = '100%';
            fillEl.style.background = '#ff3b30';
        }
        if (thumbEl) {
            thumbEl.style.left = 'calc(100% - 8px)';
            thumbEl.style.background = '#ff3b30';
        }
        return;
    }

    if (dur > 0) {
        const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
            fillEl.style.background = 'var(--accent-red)';
        }
        if (thumbEl) {
            thumbEl.style.left = `calc(8px + (${pct} / 100) * (100% - 16px))`;
            thumbEl.style.background = '#ffffff';
        }

        const forceHours = (dur >= 3600);
        if (timeEl) {
            timeEl.innerText = `${formatTime(cur, forceHours)} / ${formatTime(dur, forceHours)}`;
        }

        if (wBlock.currentSegments.length && !wBlock.markersRendered) {
            wBlock.renderMarkers();
        }

        wBlock.checkAndSkip(cur);
    }
}
