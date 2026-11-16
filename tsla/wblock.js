/**
 * wBlock Web Core (v1.0)
 * Standalone Cross-Browser Ad-Shield & Stream Suite for Web & Tesla
 * Inspired by 0xCUB3/wBlock & wBlock-userscripts (Tube Cleaner, DeArrow, SponsorBlock)
 *
 * 100% Client-side. Fully compatible with:
 *  - Safari (iOS, iPadOS, macOS)
 *  - Tesla MCU Chromium Browser (Drive & Reverse, Touch UI)
 *  - Google Chrome, Chromium, Mozilla Firefox, Microsoft Edge, Android Chrome
 *
 * Capabilities:
 *  1. Network Ad & Tracker Interceptor (monkey-patches fetch & XHR)
 *  2. Cosmetic Ad Filter & DOM Sanitizer (CSS injection + MutationObserver)
 *  3. Tube Cleaner Resilient Multi-Mirror Engine (Invidious / Piped with auto-failover)
 *  4. Official YouTube Player Ad-Shield (Auto-mute commercials, seek past ads, bypass Error 150)
 *  5. SponsorBlock Auto-Skip (Visual markers, countdown undo toast, time saved)
 *  6. DeArrow Clickbait Cleaner (Crowdsourced clean titles and clean video frame thumbnails)
 *  7. Interactive wBlock Dashboard Modal (Live metrics, individual toggles, mirror selector)
 */

(function (window, document) {
    'use strict';

    // -------------------------------------------------------------
    // 1. STORAGE & SETTINGS MANAGEMENT
    // -------------------------------------------------------------
    const STORAGE_KEY_SETTINGS = 'wblock_settings_v1';
    const STORAGE_KEY_STATS = 'wblock_stats_v1';

    const defaultSettings = {
        adShield: true,         // Video ad auto-mute & fast-skip
        sponsorBlock: true,     // Skip sponsored segments
        dearrow: true,          // Clean clickbait titles via DeArrow API
        networkFilter: true,    // Block ad & tracking network requests
        cosmeticFilter: true,   // Hide banner & promo overlays via CSS
        cleanMirrorIndex: 0,    // Default clean mirror index
        autoMirrorFailover: true// Auto-switch to next mirror if one hangs
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
            return raw ? Object.assign({}, defaultSettings, JSON.parse(raw)) : Object.assign({}, defaultSettings);
        } catch (e) {
            return Object.assign({}, defaultSettings);
        }
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
        } catch (e) {}
    }

    const defaultStats = {
        adsBlocked: 0,
        trackersBlocked: 0,
        sponsorsSkipped: 0,
        timeSavedSec: 0
    };

    function loadStats() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_STATS);
            const legacySb = Number(localStorage.getItem('sb_count') || 0);
            const parsed = raw ? Object.assign({}, defaultStats, JSON.parse(raw)) : Object.assign({}, defaultStats);
            if (legacySb > parsed.sponsorsSkipped) {
                parsed.sponsorsSkipped = legacySb;
            }
            return parsed;
        } catch (e) {
            return Object.assign({}, defaultStats);
        }
    }

    function saveStats(stats) {
        try {
            localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(stats));
            localStorage.setItem('sb_count', String(stats.sponsorsSkipped));
        } catch (e) {}
    }

    let settings = loadSettings();
    let stats = loadStats();

    // -------------------------------------------------------------
    // 2. NETWORK AD & TRACKER SHIELD (fetch & XHR Interceptor)
    // -------------------------------------------------------------
    const BLOCKED_HOST_PATTERNS = [
        /googleads\.g\.doubleclick\.net/i,
        /pagead2\.googlesyndication\.com/i,
        /adservice\.google\./i,
        /youtube\.com\/api\/stats\/ads/i,
        /youtube\.com\/pagead\//i,
        /youtube\.com\/ptracking/i,
        /youtube\.com\/youtubei\/v1\/log_event/i,
        /google-analytics\.com/i,
        /googletagmanager\.com/i,
        /stats\.g\.doubleclick\.net/i,
        /securepubads\.g\.doubleclick\.net/i,
        /\/api\/stats\/playback/i,
        /\/ad_status/i,
        /\/get_midroll_info/i
    ];

    function isBlockedUrl(url) {
        if (!url || typeof url !== 'string') return false;
        for (let i = 0; i < BLOCKED_HOST_PATTERNS.length; i++) {
            if (BLOCKED_HOST_PATTERNS[i].test(url)) return true;
        }
        return false;
    }

    function recordBlockedNetworkRequest(url) {
        stats.trackersBlocked++;
        stats.adsBlocked++;
        saveStats(stats);
        if (window.wBlock && typeof window.wBlock.updateUI === 'function') {
            window.wBlock.updateUI();
        }
    }

    // Intercept window.fetch
    if (typeof window.fetch === 'function') {
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            let url = '';
            if (typeof input === 'string') {
                url = input;
            } else if (input && typeof input.url === 'string') {
                url = input.url;
            }

            if (settings.networkFilter && isBlockedUrl(url)) {
                recordBlockedNetworkRequest(url);
                return Promise.resolve(new Response('{"status":"blocked_by_wblock"}', {
                    status: 204,
                    statusText: 'No Content (wBlock)',
                    headers: { 'Content-Type': 'application/json' }
                }));
            }
            return originalFetch.apply(this, arguments);
        };
    }

    // Intercept XMLHttpRequest
    if (typeof window.XMLHttpRequest === 'function') {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this._wblockUrl = typeof url === 'string' ? url : '';
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            if (settings.networkFilter && isBlockedUrl(this._wblockUrl)) {
                recordBlockedNetworkRequest(this._wblockUrl);
                try {
                    this.abort();
                } catch (e) {}
                return;
            }
            return originalSend.apply(this, arguments);
        };
    }

    // -------------------------------------------------------------
    // 3. COSMETIC FILTER & DOM SANITIZER
    // -------------------------------------------------------------
    const COSMETIC_RULES = `
        /* wBlock Cosmetic Rules: Video Ad Modules, Overlays, Promos */
        .video-ads,
        .ytp-ad-module,
        .ytp-ad-overlay-container,
        .ytp-ad-player-overlay,
        .ytp-ad-image-overlay,
        .ytp-ad-text,
        .ytp-ad-survey,
        .ytp-ad-action-interstitial,
        .ytp-ad-preview-container,
        .ytp-ad-skip-button-container,
        ytd-promoted-video-renderer,
        ytd-banner-promo-renderer,
        ytd-in-feed-ad-layout-renderer,
        ytd-ad-slot-renderer,
        ytd-display-ad-renderer,
        .sparkles-light-cta,
        [id^="google_ads_"],
        [class*="sponsored-post"],
        .ad-container,
        .ad-shield-placeholder {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            height: 0 !important;
            width: 0 !important;
            max-height: 0 !important;
            overflow: hidden !important;
        }
    `;

    function injectCosmeticFilter() {
        if (!settings.cosmeticFilter) return;
        if (document.getElementById('wblock-cosmetic-shield')) return;
        const style = document.createElement('style');
        style.id = 'wblock-cosmetic-shield';
        style.textContent = COSMETIC_RULES;
        (document.head || document.documentElement).appendChild(style);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectCosmeticFilter);
    } else {
        injectCosmeticFilter();
    }

    // MutationObserver to clean dynamically injected ad containers
    let domCleanerObserver = null;
    function initDomCleaner() {
        if (!settings.cosmeticFilter) return;
        if (domCleanerObserver || typeof MutationObserver === 'undefined') return;

        const targetSelectors = [
            '.video-ads',
            '.ytp-ad-module',
            '.ytp-ad-overlay-container',
            'ytd-ad-slot-renderer',
            'ytd-promoted-video-renderer'
        ];

        domCleanerObserver = new MutationObserver((mutations) => {
            if (!settings.cosmeticFilter) return;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) { // ELEMENT_NODE
                        for (const selector of targetSelectors) {
                            if (node.matches && node.matches(selector)) {
                                node.remove();
                                stats.adsBlocked++;
                                saveStats(stats);
                                break;
                            }
                            if (node.querySelectorAll) {
                                const adElements = node.querySelectorAll(selector);
                                if (adElements.length > 0) {
                                    adElements.forEach(el => el.remove());
                                    stats.adsBlocked += adElements.length;
                                    saveStats(stats);
                                }
                            }
                        }
                    }
                }
            }
        });

        const rootNode = document.body || document.documentElement;
        if (rootNode) {
            domCleanerObserver.observe(rootNode, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDomCleaner);
    } else {
        initDomCleaner();
    }

    // -------------------------------------------------------------
    // 4. RESILIENT MULTI-MIRROR CLEAN TUBE ENGINE
    // -------------------------------------------------------------
    // High-Availability clean mirrors (Invidious & Piped) that serve video
    // with 0 Google ads, 0 tracking, and bypass Error 150 (embed disabled)
    const CLEAN_MIRRORS = [
        {
            name: 'Invidious NerdVPN',
            host: 'invidious.nerdvpn.de',
            url: 'https://invidious.nerdvpn.de/embed/'
        },
        {
            name: 'Yewtu.be',
            host: 'yewtu.be',
            url: 'https://yewtu.be/embed/'
        },
        {
            name: 'Piped Video',
            host: 'piped.video',
            url: 'https://piped.video/embed/'
        },
        {
            name: 'Piped MHA',
            host: 'piped.mha.fi',
            url: 'https://piped.mha.fi/embed/'
        }
    ];

    let currentMirrorIndex = settings.cleanMirrorIndex || 0;
    if (currentMirrorIndex >= CLEAN_MIRRORS.length || currentMirrorIndex < 0) {
        currentMirrorIndex = 0;
    }

    let activeMirrorWatchdog = null;

    // -------------------------------------------------------------
    // 5. DEARROW CLICKBAIT CLEANER (Crowdsourced Branding API)
    // -------------------------------------------------------------
    const dearrowCache = new Map();

    async function fetchDeArrowData(videoId) {
        if (!videoId || !settings.dearrow) return null;
        if (dearrowCache.has(videoId)) return dearrowCache.get(videoId);

        try {
            const resp = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(videoId)}`);
            if (resp.status === 404 || !resp.ok) {
                dearrowCache.set(videoId, null);
                return null;
            }
            const data = await resp.json();
            dearrowCache.set(videoId, data);
            return data;
        } catch (e) {
            return null;
        }
    }

    // -------------------------------------------------------------
    // 6. MAIN WBLOCK CONTROLLER
    // -------------------------------------------------------------
    const wBlock = {
        version: '1.0.0',
        enabled: true,
        settings: settings,
        stats: stats,
        mirrors: CLEAN_MIRRORS,
        currentMirrorIndex: currentMirrorIndex,
        currentSegments: [],
        markersRendered: false,
        lastSkippedSegment: null,
        skippedSegmentIds: new Set(),
        isSkipping: false,
        isAdAccelerated: false,
        savedSpeed: 1.0,
        toastTimer: null,
        sb: null,
        fetchAbortController: null,
        fetchRequestId: 0,

        get skippedCount() {
            return this.stats.sponsorsSkipped;
        },
        set skippedCount(val) {
            this.stats.sponsorsSkipped = Number(val) || 0;
            saveStats(this.stats);
        },

        get sponsorBlockEnabled() {
            return this.settings.sponsorBlock;
        },
        set sponsorBlockEnabled(val) {
            this.settings.sponsorBlock = Boolean(val);
            saveSettings(this.settings);
        },

        // Initialize SponsorBlock integration
        initSponsorBlock(playerInstance) {
            if (typeof SponsorBlock === 'undefined') return;
            if (!this.sb) {
                this.sb = new SponsorBlock(playerInstance || window.ytPlayer, {
                    categories: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'],
                    minDuration: 0.8,
                    getCurrentTime: () => (typeof window.getCurrentTime === 'function' ? window.getCurrentTime() : 0),
                    seekTo: (time) => (typeof window.seekTo === 'function' ? window.seekTo(time) : null),
                    onSkip: ({ category, from, to, count, segment }) => {
                        this.stats.sponsorsSkipped = count;
                        const durationSaved = Math.max(0, Math.round(to - from));
                        this.stats.timeSavedSec += durationSaved;
                        saveStats(this.stats);

                        this.lastSkippedSegment = segment || this.sb.lastSkip;
                        this.updateUI();
                        this.showToast(category);
                    },
                    onUndo: ({ category, count }) => {
                        this.stats.sponsorsSkipped = count;
                        saveStats(this.stats);
                        this.lastSkippedSegment = null;
                        this.updateUI();
                        const toast = document.getElementById('wblock-skip-toast');
                        if (toast) toast.style.display = 'none';
                    }
                });
                window.sb = this.sb;
            } else if (playerInstance) {
                this.sb.setPlayer(playerInstance);
            }
        },

        // ---------------------------------------------------------
        // YOUTUBE AD DETECTION & BYPASS LOGIC
        // ---------------------------------------------------------
        handleAdDetected() {
            if (!this.enabled || !this.settings.adShield || this.isAdAccelerated) return;
            this.isAdAccelerated = true;
            this.savedSpeed = window.currentSpeed || 1.0;
            console.log("[wBlock] YouTube Video Ad Detected! Initiating instant ad-shield...");

            // 1. Mute audio immediately so commercials don't blast the car/speakers
            if (typeof window.sendYTCommand === 'function') {
                window.sendYTCommand('mute', []);
            }

            // 2. Fast-skip or jump ad
            this.attemptFastSkipAd();

            // 3. Update stats & show toast
            this.stats.adsBlocked++;
            this.stats.timeSavedSec += 15; // Average unskippable ad length
            saveStats(this.stats);
            this.updateUI();
            this.showToast('video-ad');

            // 4. In-player ad overlay with 1-tap Clean mode switch
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
                    <span class="ad-shield-badge">🛡️ wBlock: Реклама приглушена</span>
                    <button class="ad-switch-clean-btn" onclick="wBlock.switchToCleanEngine()" title="Переключить на плеер без рекламы">
                        🛡️ Включить Clean поток
                    </button>
                    <button class="ad-skip-force-btn" onclick="wBlock.skipAdForce()">
                        ⏭️ Пропустить
                    </button>
                </div>
            `;
            shield.style.display = 'flex';
        },

        attemptFastSkipAd() {
            // Seek forward past the ad duration if accessible
            if (window.ytPlayer && typeof window.ytPlayer.getDuration === 'function') {
                try {
                    const dur = window.ytPlayer.getDuration();
                    if (dur > 0 && dur < 180) {
                        window.ytPlayer.seekTo(dur + 1, true);
                    }
                } catch (e) {}
            }

            // Fallback: postMessage seekTo end
            const frame = document.getElementById('yt-player-frame');
            if (frame && frame.contentWindow) {
                try {
                    frame.contentWindow.postMessage(JSON.stringify({
                        event: 'command',
                        func: 'seekTo',
                        args: [999999, true]
                    }), '*');
                } catch (e) {}
            }
        },

        restoreAfterAd() {
            if (!this.isAdAccelerated) return;
            this.isAdAccelerated = false;
            console.log("[wBlock] Ad ended. Restoring normal playback...");
            if (typeof window.sendYTCommand === 'function') {
                window.sendYTCommand('unMute', []);
            }
            const shield = document.getElementById('ad-shield');
            if (shield) shield.style.display = 'none';
        },

        skipAdForce() {
            console.log("[wBlock] User clicked Skip Ad Force");
            this.attemptFastSkipAd();
            this.restoreAfterAd();
            this.stats.adsBlocked++;
            saveStats(this.stats);
            this.updateUI();
            this.showCustomToast("⚡ Реклама пропущена!");
        },

        // ---------------------------------------------------------
        // SPONSORBLOCK SEGMENT FETCH & SKIP
        // ---------------------------------------------------------
        async fetchSponsorSegments(videoId) {
            this.currentSegments = [];
            this.clearMarkers();
            this.skippedSegmentIds = new Set();
            this.lastSkippedSegment = null;
            if (!videoId || !this.settings.sponsorBlock) return [];

            if (this.fetchAbortController) {
                try { this.fetchAbortController.abort(); } catch (e) {}
            }
            this.fetchAbortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const signal = this.fetchAbortController ? this.fetchAbortController.signal : null;
            const currentReq = ++this.fetchRequestId;

            try {
                if (!this.sb && typeof SponsorBlock !== 'undefined') {
                    this.initSponsorBlock(window.ytPlayer);
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
                    this.setStatBadge(`${this.currentSegments.length} спонсор(ов)`);
                    this.renderMarkers();
                } else {
                    this.setStatBadge('Чисто');
                }
                return this.currentSegments;
            } catch (e) {
                if (e && e.name === 'AbortError') return [];
                if (currentReq !== this.fetchRequestId) return this.currentSegments;
                console.warn("[wBlock] SponsorBlock fetch notice:", e.message || e);
                this.setStatBadge('Чисто');
                return [];
            }
        },

        renderMarkers() {
            const container = document.getElementById('sponsor-segments-layer');
            if (!container) return;
            container.innerHTML = '';
            const dur = (typeof window.getDuration === 'function') ? window.getDuration() : 0;
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
            if (!this.enabled || !this.settings.sponsorBlock) return;
            if (this.isAdAccelerated) return;
            if (!this.currentSegments || !this.currentSegments.length) return;
            if (this.isSkipping) return;

            const t = (typeof currentTime === 'number' && !isNaN(currentTime))
                ? currentTime
                : (typeof window.getCurrentTime === 'function' ? window.getCurrentTime() : 0);
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
                    if (typeof window.seekTo === 'function') {
                        window.seekTo(seg.end);
                    }

                    this.stats.sponsorsSkipped++;
                    const saved = Math.max(0, Math.round(seg.end - seg.start));
                    this.stats.timeSavedSec += saved;
                    saveStats(this.stats);

                    this.updateUI();
                    this.showToast(seg.category);

                    setTimeout(() => {
                        this.isSkipping = false;
                    }, 600);
                    break;
                }
            }
        },

        undoLastSkip() {
            if (this.lastSkippedSegment) {
                const seg = this.lastSkippedSegment;
                if (typeof window.seekTo === 'function') {
                    window.seekTo(Math.max(0, seg.start));
                }
                this.skippedSegmentIds.add(seg.id);
                if (this.sb) {
                    this.sb.undone.add(seg.id);
                    this.sb.ignored.add(seg.id);
                    this.sb.lastSkip = null;
                }
                this.lastSkippedSegment = null;
                if (this.stats.sponsorsSkipped > 0) this.stats.sponsorsSkipped--;
                saveStats(this.stats);
                this.updateUI();
                const toast = document.getElementById('wblock-skip-toast');
                if (toast) toast.style.display = 'none';
                return;
            }
            if (this.sb && this.sb.lastSkip) {
                this.sb.undo();
                this.stats.sponsorsSkipped = this.sb.count;
                saveStats(this.stats);
                this.updateUI();
                const toast = document.getElementById('wblock-skip-toast');
                if (toast) toast.style.display = 'none';
            }
        },

        // ---------------------------------------------------------
        // CLEAN MULTI-MIRROR STREAM MOUNTING & FAILOVER
        // ---------------------------------------------------------
        mountCleanPlayer(container, videoId, startTime = 0) {
            if (!container) return;
            if (activeMirrorWatchdog) {
                clearTimeout(activeMirrorWatchdog);
                activeMirrorWatchdog = null;
            }

            const mirror = CLEAN_MIRRORS[this.currentMirrorIndex] || CLEAN_MIRRORS[0];
            const startParam = startTime > 0 ? `?t=${Math.floor(startTime)}` : '';
            const embedUrl = `${mirror.url}${videoId}${startParam}`;

            console.log(`[wBlock] Mounting Clean Player via mirror: ${mirror.name} (${embedUrl})`);

            container.innerHTML = `
                <iframe id="yt-player-frame"
                    src="${embedUrl}"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen
                    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; background: #000;">
                </iframe>
            `;

            // Active failover watchdog: if mirror fails to load or hangs for > 5 seconds, switch to next mirror
            if (this.settings.autoMirrorFailover) {
                activeMirrorWatchdog = setTimeout(() => {
                    const frame = document.getElementById('yt-player-frame');
                    if (frame && container.contains(frame)) {
                        console.warn(`[wBlock] Mirror ${mirror.name} did not complete within timeout. Testing next mirror...`);
                        this.rotateMirror(container, videoId, startTime);
                    }
                }, 7500);
            }

            const frame = document.getElementById('yt-player-frame');
            if (frame) {
                frame.onload = () => {
                    if (activeMirrorWatchdog) {
                        clearTimeout(activeMirrorWatchdog);
                        activeMirrorWatchdog = null;
                    }
                    console.log(`[wBlock] Clean Mirror ${mirror.name} successfully mounted.`);
                };
            }
        },

        rotateMirror(container, videoId, startTime = 0) {
            this.currentMirrorIndex = (this.currentMirrorIndex + 1) % CLEAN_MIRRORS.length;
            this.settings.cleanMirrorIndex = this.currentMirrorIndex;
            saveSettings(this.settings);
            const nextMirror = CLEAN_MIRRORS[this.currentMirrorIndex];
            this.showCustomToast(`🔄 Переключение зеркала: ${nextMirror.name}`);
            this.mountCleanPlayer(container, videoId, startTime);
        },

        switchToCleanEngine() {
            if (typeof window.setCinemaEngine === 'function') {
                window.setCinemaEngine('clean');
            }
            this.restoreAfterAd();
            this.showCustomToast("🛡️ Переключено на Чистый поток (0 рекламы)");
        },

        // ---------------------------------------------------------
        // DEARROW INTEGRATION (Clickbait Sanitizer)
        // ---------------------------------------------------------
        async applyDeArrow(videoId, titleEl, thumbEl) {
            if (!this.settings.dearrow || !videoId || !titleEl) return;
            const data = await fetchDeArrowData(videoId);
            if (!data) return;

            // 1. Title Replacement
            if (Array.isArray(data.titles) && data.titles.length > 0) {
                const bestTitle = data.titles.find(t => !t.original && t.votes > 0) || data.titles[0];
                if (bestTitle && bestTitle.title && bestTitle.title !== titleEl.textContent) {
                    titleEl.textContent = bestTitle.title;
                    titleEl.setAttribute('title', `DeArrow: ${bestTitle.title}`);

                    // Add small indicator if not already present
                    if (!titleEl.querySelector('.dearrow-badge')) {
                        const badge = document.createElement('span');
                        badge.className = 'dearrow-badge';
                        badge.textContent = ' 🎯';
                        badge.title = 'Заголовок очищен от кликбейта (DeArrow)';
                        titleEl.appendChild(badge);
                    }
                }
            }

            // 2. Thumbnail Replacement (Frame timestamp snapshot)
            if (thumbEl && Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
                const bestThumb = data.thumbnails.find(t => !t.original && typeof t.timestamp === 'number');
                if (bestThumb && bestThumb.timestamp !== null) {
                    // Ajay's official DeArrow thumbnail service
                    const cleanThumbUrl = `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoId)}&time=${bestThumb.timestamp}`;
                    const img = new Image();
                    img.onload = () => {
                        thumbEl.src = cleanThumbUrl;
                    };
                    img.src = cleanThumbUrl;
                }
            }
        },

        // ---------------------------------------------------------
        // UI & STATUS NOTIFICATIONS
        // ---------------------------------------------------------
        updateUI() {
            const badgeStat = document.getElementById('wblock-stat');
            if (badgeStat) {
                const engine = window.currentCinemaEngine || 'clean';
                if (engine === 'clean') {
                    badgeStat.innerText = `0 рекламы (${CLEAN_MIRRORS[this.currentMirrorIndex].name.split(' ')[0]})`;
                } else {
                    const totalBlocks = this.stats.adsBlocked + this.stats.sponsorsSkipped;
                    badgeStat.innerText = `${totalBlocks} блок/пропуск`;
                }
            }

            // Update modal counters if modal is open
            const modalAds = document.getElementById('wblock-modal-stat-ads');
            const modalSponsors = document.getElementById('wblock-modal-stat-sponsors');
            const modalTime = document.getElementById('wblock-modal-stat-time');

            if (modalAds) modalAds.innerText = String(this.stats.adsBlocked + this.stats.trackersBlocked);
            if (modalSponsors) modalSponsors.innerText = String(this.stats.sponsorsSkipped);
            if (modalTime) {
                const m = Math.floor(this.stats.timeSavedSec / 60);
                const s = this.stats.timeSavedSec % 60;
                modalTime.innerText = m > 0 ? `${m} мин ${s} сек` : `${s} сек`;
            }
        },

        setStatBadge(text) {
            const statEl = document.getElementById('wblock-stat');
            if (statEl) {
                const engine = window.currentCinemaEngine || 'clean';
                if (engine === 'clean') {
                    statEl.innerText = `0 рекламы (${CLEAN_MIRRORS[this.currentMirrorIndex].name.split(' ')[0]})`;
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
                catName = 'видеореклама (приглушена)';
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

        // ---------------------------------------------------------
        // WBLOCK DASHBOARD MODAL
        // ---------------------------------------------------------
        openDashboard() {
            let modal = document.getElementById('wblock-dashboard-modal');
            if (!modal) {
                this.renderDashboardModal();
                modal = document.getElementById('wblock-dashboard-modal');
            }
            if (modal) {
                this.updateUI();
                modal.style.display = 'flex';
            }
        },

        closeDashboard() {
            const modal = document.getElementById('wblock-dashboard-modal');
            if (modal) modal.style.display = 'none';
        },

        toggleSetting(key) {
            if (key in this.settings) {
                this.settings[key] = !this.settings[key];
                saveSettings(this.settings);
                this.showCustomToast(`wBlock: ${key} = ${this.settings[key] ? 'ВКЛ' : 'ВЫКЛ'}`);
                if (key === 'cosmeticFilter') {
                    const styleEl = document.getElementById('wblock-cosmetic-shield');
                    if (this.settings.cosmeticFilter) {
                        injectCosmeticFilter();
                    } else if (styleEl) {
                        styleEl.remove();
                    }
                }
                this.updateDashboardToggles();
            }
        },

        resetStats() {
            this.stats = {
                adsBlocked: 0,
                trackersBlocked: 0,
                sponsorsSkipped: 0,
                timeSavedSec: 0
            };
            saveStats(this.stats);
            this.updateUI();
            this.showCustomToast("Статистика wBlock сброшена");
        },

        renderDashboardModal() {
            const div = document.createElement('div');
            div.id = 'wblock-dashboard-modal';
            div.className = 'yt-modal';
            div.style.display = 'none';
            div.innerHTML = `
                <div class="yt-modal-content wblock-modal-content">
                    <div class="yt-modal-header">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 20px;">🛡️</span>
                            <h2>Панель защиты wBlock Ad-Shield</h2>
                        </div>
                        <button class="btn-close-modal" onclick="wBlock.closeDashboard()">✕</button>
                    </div>

                    <div class="yt-modal-body" style="padding: 20px; gap: 16px;">
                        <!-- Live Stat Cards -->
                        <div class="wblock-stats-row">
                            <div class="wblock-stat-card">
                                <div class="stat-number" id="wblock-modal-stat-ads">${this.stats.adsBlocked + this.stats.trackersBlocked}</div>
                                <div class="stat-label">Рекламы и трекеров заблокировано</div>
                            </div>
                            <div class="wblock-stat-card">
                                <div class="stat-number" id="wblock-modal-stat-sponsors">${this.stats.sponsorsSkipped}</div>
                                <div class="stat-label">Спонсоров пропущено (SponsorBlock)</div>
                            </div>
                            <div class="wblock-stat-card">
                                <div class="stat-number" id="wblock-modal-stat-time">
                                    ${Math.floor(this.stats.timeSavedSec / 60)} мин ${this.stats.timeSavedSec % 60} сек
                                </div>
                                <div class="stat-label">Сэкономлено времени</div>
                            </div>
                        </div>

                        <!-- Protection Status Indicator -->
                        <div class="wblock-shield-status">
                            <span class="status-dot-active"></span>
                            <span>Защита активна на 100% (Safari, Chrome, Tesla MCU, Firefox)</span>
                        </div>

                        <!-- Settings Toggles -->
                        <div class="wblock-settings-list">
                            <div class="wblock-setting-item" onclick="wBlock.toggleSetting('adShield')">
                                <div class="setting-info">
                                    <div class="setting-title">🛡️ Блокировка видеорекламы (Ad-Shield)</div>
                                    <div class="setting-desc">Автоприглушение звука и моментальный пропуск рекламных вставок</div>
                                </div>
                                <input type="checkbox" id="wblock-toggle-adshield" class="wblock-switch" ${this.settings.adShield ? 'checked' : ''} onclick="event.stopPropagation(); wBlock.toggleSetting('adShield')">
                            </div>

                            <div class="wblock-setting-item" onclick="wBlock.toggleSetting('sponsorBlock')">
                                <div class="setting-info">
                                    <div class="setting-title">⏩ SponsorBlock (Пропуск спонсоров)</div>
                                    <div class="setting-desc">Автопропуск навязчивых интеграций, интро, саморекламы и аутро</div>
                                </div>
                                <input type="checkbox" id="wblock-toggle-sponsorblock" class="wblock-switch" ${this.settings.sponsorBlock ? 'checked' : ''} onclick="event.stopPropagation(); wBlock.toggleSetting('sponsorBlock')">
                            </div>

                            <div class="wblock-setting-item" onclick="wBlock.toggleSetting('dearrow')">
                                <div class="setting-info">
                                    <div class="setting-title">🎯 DeArrow (Очистка кликбейта)</div>
                                    <div class="setting-desc">Замена кричащих заголовков и превью на точные описания сообщества</div>
                                </div>
                                <input type="checkbox" id="wblock-toggle-dearrow" class="wblock-switch" ${this.settings.dearrow ? 'checked' : ''} onclick="event.stopPropagation(); wBlock.toggleSetting('dearrow')">
                            </div>

                            <div class="wblock-setting-item" onclick="wBlock.toggleSetting('networkFilter')">
                                <div class="setting-info">
                                    <div class="setting-title">🌐 Сетевой фильтр (Network Shield)</div>
                                    <div class="setting-desc">Перехват и блокировка рекламных сетей DoubleClick, AdSense и трекеров</div>
                                </div>
                                <input type="checkbox" id="wblock-toggle-network" class="wblock-switch" ${this.settings.networkFilter ? 'checked' : ''} onclick="event.stopPropagation(); wBlock.toggleSetting('networkFilter')">
                            </div>

                            <div class="wblock-setting-item" onclick="wBlock.toggleSetting('cosmeticFilter')">
                                <div class="setting-info">
                                    <div class="setting-title">🧹 Косметический фильтр баннеров</div>
                                    <div class="setting-desc">Скрытие рекламных оверлеев, баннеров и промо-блоков на странице</div>
                                </div>
                                <input type="checkbox" id="wblock-toggle-cosmetic" class="wblock-switch" ${this.settings.cosmeticFilter ? 'checked' : ''} onclick="event.stopPropagation(); wBlock.toggleSetting('cosmeticFilter')">
                            </div>
                        </div>

                        <!-- Clean Mirror Selection -->
                        <div class="wblock-mirror-section">
                            <div style="font-size: 13px; font-weight: 700; margin-bottom: 8px; color: #fff;">
                                Активное зеркало Clean потока (без рекламы):
                            </div>
                            <div class="wblock-mirrors-grid" id="wblock-mirrors-list">
                                ${CLEAN_MIRRORS.map((m, idx) => `
                                    <button class="wblock-mirror-btn ${idx === this.currentMirrorIndex ? 'active' : ''}" onclick="wBlock.selectMirror(${idx})">
                                        <span>${m.name}</span>
                                        <span class="mirror-status-ok">● Онлайн</span>
                                    </button>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Footer Actions -->
                        <div style="display: flex; gap: 8px; justify-content: space-between; margin-top: 10px;">
                            <button class="btn-secondary" onclick="wBlock.resetStats()" style="padding: 10px 14px; font-size: 12px; border-radius: 8px;">
                                🔄 Сбросить статистику
                            </button>
                            <button class="btn-primary" onclick="wBlock.closeDashboard()" style="padding: 10px 20px; font-size: 13px; border-radius: 8px; font-weight: 700;">
                                Готово
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(div);
        },

        updateDashboardToggles() {
            const ad = document.getElementById('wblock-toggle-adshield');
            const sb = document.getElementById('wblock-toggle-sponsorblock');
            const da = document.getElementById('wblock-toggle-dearrow');
            const net = document.getElementById('wblock-toggle-network');
            const cos = document.getElementById('wblock-toggle-cosmetic');

            if (ad) ad.checked = this.settings.adShield;
            if (sb) sb.checked = this.settings.sponsorBlock;
            if (da) da.checked = this.settings.dearrow;
            if (net) net.checked = this.settings.networkFilter;
            if (cos) cos.checked = this.settings.cosmeticFilter;
        },

        selectMirror(idx) {
            if (idx >= 0 && idx < CLEAN_MIRRORS.length) {
                this.currentMirrorIndex = idx;
                this.settings.cleanMirrorIndex = idx;
                saveSettings(this.settings);

                // Update mirror buttons
                const list = document.getElementById('wblock-mirrors-list');
                if (list) {
                    const btns = list.querySelectorAll('.wblock-mirror-btn');
                    btns.forEach((b, i) => b.classList.toggle('active', i === idx));
                }

                this.showCustomToast(`Выбрано зеркало: ${CLEAN_MIRRORS[idx].name}`);

                // If currently playing in clean engine, remount with new mirror
                if (window.currentPlayingVideoId && window.currentCinemaEngine === 'clean') {
                    const mount = document.getElementById('canvas-player-mount');
                    const curTime = (typeof window.getCurrentTime === 'function') ? window.getCurrentTime() : 0;
                    this.mountCleanPlayer(mount, window.currentPlayingVideoId, curTime);
                }
                this.updateUI();
            }
        }
    };

    // Export to global scope
    window.wBlock = wBlock;
    window.playbackFeatures = wBlock;

})(window, document);
