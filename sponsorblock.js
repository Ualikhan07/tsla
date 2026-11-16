/*
 * sponsorblock.js — модуль интеграции с базой SponsorBlock (https://sponsor.ajay.app)
 * Поддерживает:
 *  - K-Anonymity SHA-256 префиксы (privacy-friendly) + автоматический прямой fallback
 *  - Автоматический пропуск спонсоров, интро, аутро, саморекламы
 *  - Отрисовку меток на полосе воспроизведения
 *  - Поддержку отмены пропуска (Undo) без повторного срабатывания
 *  - Защиту от race conditions (быстрое переключение видео, AbortController)
 *  - Подтверждение успешной перемотки перед фиксацией пропуска
 *  - Совместимость как с YouTube IFrame, так и с HTML5/Canvas плеерами
 */
(function () {
  const API_PREFIX = 'https://sponsor.ajay.app/api/skipSegments/';
  const API_DIRECT = 'https://sponsor.ajay.app/api/skipSegments';
  const DEFAULT_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'];
  const DEFAULT_ACTION_TYPES = ['skip'];

  async function sha256hex(text) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        return '';
      }
    }
    return '';
  }

  function readCount() {
    try { return Number(localStorage.getItem('sb_count') || 0); } catch { return 0; }
  }
  function writeCount(n) {
    try { localStorage.setItem('sb_count', String(n)); } catch {}
  }

  function parseRawSegments(rawList, allowedCategories) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .filter(s => !s.actionType || s.actionType === 'skip')
      .filter(s => Array.isArray(s.segment) && s.segment.length >= 2)
      .filter(s => {
        const [start, end] = s.segment;
        return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && (end - start >= 0.8);
      })
      .filter(s => !allowedCategories || allowedCategories.includes(s.category))
      .map(s => ({
        start: s.segment[0],
        end: s.segment[1],
        category: s.category,
        id: s.UUID || `${s.category}_${s.segment[0].toFixed(1)}_${s.segment[1].toFixed(1)}`,
        videoDuration: s.videoDuration || 0
      }))
      .sort((a, b) => a.start - b.start);
  }

  // Универсальный статический метод загрузки сегментов
  async function fetchSponsorSegments(videoId, categories = DEFAULT_CATEGORIES, signal = null) {
    if (!videoId || typeof videoId !== 'string') return [];
    const cleanId = videoId.trim();
    if (!/^[\w-]{11}$/.test(cleanId)) return [];

    if (!categories || categories.length === 0) return [];

    const params = new URLSearchParams({
      categories: JSON.stringify(categories),
      actionTypes: JSON.stringify(DEFAULT_ACTION_TYPES)
    });

    let prefix = '';
    try {
      const hash = await sha256hex(cleanId);
      prefix = hash ? hash.slice(0, 4) : '';
    } catch (e) {
      prefix = '';
    }

    // 1. Попытка через 4-значный SHA-256 префикс (K-Anonymity)
    if (prefix) {
      const url = `${API_PREFIX}${prefix}?${params.toString()}`;
      const resp = await fetch(url, { signal });
      if (resp.status === 404) return [];
      if (resp.status >= 400) {
        throw new Error(`HTTP ${resp.status}`);
      }
      if (resp.ok) {
        const list = await resp.json();
        if (Array.isArray(list)) {
          const entry = list.find(v => v.videoID === cleanId);
          if (entry && Array.isArray(entry.segments)) {
            return parseRawSegments(entry.segments, categories);
          }
        }
        return [];
      }
    }

    // 2. Прямой запрос по videoID (надежный fallback)
    const directUrl = `${API_DIRECT}?videoID=${encodeURIComponent(cleanId)}&${params.toString()}`;
    const resp = await fetch(directUrl, { signal });
    if (resp.status === 404) return [];
    if (resp.status >= 400) {
      throw new Error(`HTTP ${resp.status}`);
    }
    if (resp.ok) {
      const raw = await resp.json();
      if (Array.isArray(raw)) {
        return parseRawSegments(raw, categories);
      }
    }

    return [];
  }

  class SponsorBlock {
    constructor(player, opts = {}) {
      this.player = player;
      this.categories = opts.categories || DEFAULT_CATEGORIES;
      this.minDuration = opts.minDuration ?? 0.8;
      this.onSkip = opts.onSkip || (() => {});
      this.onUndo = opts.onUndo || (() => {});
      this.getCurrentTimeFn = opts.getCurrentTime || null;
      this.seekToFn = opts.seekTo || null;
      this.segments = [];
      this.ignored = new Set();
      this.undone = new Set();
      this.lastSkip = null;
      this.timer = null;
      this.count = readCount();
      this.requestVersion = 0;
      this.videoId = null;
      this._abortController = null;
      this._isSeeking = false;
      this._pendingSkip = null;
      this._seekTimestamp = 0;
    }

    setPlayer(player) {
      this.player = player;
    }

    async load(videoId) {
      this.segments = [];
      this.ignored.clear();
      this.undone.clear();
      this.lastSkip = null;
      this._isSeeking = false;
      this._pendingSkip = null;

      if (!videoId) {
        this.videoId = null;
        return [];
      }

      const request = (this.requestVersion || 0) + 1;
      this.requestVersion = request;
      this.videoId = videoId;

      if (this._abortController) {
        try { this._abortController.abort(); } catch (e) {}
      }
      this._abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const signal = this._abortController ? this._abortController.signal : null;

      try {
        const fetchFn = (typeof SponsorBlock !== 'undefined' && typeof SponsorBlock.fetchSegments === 'function')
          ? SponsorBlock.fetchSegments
          : fetchSponsorSegments;
        const loaded = await fetchFn(videoId, this.categories, signal);
        if (request !== this.requestVersion) return this.segments;
        this.segments = loaded.filter(s => (s.end - s.start) >= this.minDuration);
        return this.segments;
      } catch (err) {
        if (err && err.name === 'AbortError') return [];
        if (request !== this.requestVersion) return this.segments;
        throw err;
      }
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this._tick(), 250);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this._isSeeking = false;
      this._pendingSkip = null;
    }

    clear() {
      this.stop();
      this.segments = [];
      this.ignored.clear();
      this.undone.clear();
      this.lastSkip = null;
      this.videoId = null;
      if (this._abortController) {
        try { this._abortController.abort(); } catch(e) {}
        this._abortController = null;
      }
    }

    _getCurrentTime() {
      if (typeof this.getCurrentTimeFn === 'function') {
        try {
          const t = this.getCurrentTimeFn();
          if (typeof t === 'number' && !isNaN(t) && t >= 0) return t;
        } catch (e) {}
      }
      if (this.player) {
        if (typeof this.player.getCurrentTime === 'function') {
          try {
            const t = this.player.getCurrentTime();
            if (typeof t === 'number' && !isNaN(t) && t >= 0) return t;
          } catch (e) {}
        }
        if (typeof this.player.currentTime === 'number' && !isNaN(this.player.currentTime) && this.player.currentTime >= 0) {
          return this.player.currentTime;
        }
      }
      if (typeof window !== 'undefined' && typeof window.getCurrentTime === 'function') {
        try {
          const t = window.getCurrentTime();
          if (typeof t === 'number' && !isNaN(t) && t >= 0) return t;
        } catch (e) {}
      }
      return null;
    }

    _seekTo(seconds) {
      if (typeof this.seekToFn === 'function') {
        try { this.seekToFn(seconds); return true; } catch (e) {}
      }
      if (this.player) {
        if (typeof this.player.seekTo === 'function') {
          try { this.player.seekTo(seconds, true); return true; } catch (e) {}
        }
        if (typeof this.player.currentTime === 'number') {
          this.player.currentTime = seconds;
          return true;
        }
      }
      if (typeof window !== 'undefined' && typeof window.seekTo === 'function') {
        try { window.seekTo(seconds); return true; } catch (e) {}
      }
      return false;
    }

    _isPlaying() {
      if (this.player) {
        if (typeof this.player.getPlayerState === 'function') {
          try { return this.player.getPlayerState() === 1; } catch (e) {}
        }
        if (typeof this.player.paused === 'boolean') {
          return !this.player.paused;
        }
      }
      if (typeof isPlaying !== 'undefined') {
        return Boolean(isPlaying);
      }
      return true;
    }

    _matchesCurrentVideo() {
      if (!this.videoId) return true;
      if (this.player && typeof this.player.getVideoData === 'function') {
        try {
          const data = this.player.getVideoData();
          if (data && data.video_id && data.video_id !== this.videoId) {
            return false;
          }
        } catch (e) {}
      }
      if (typeof currentPlayingVideoId !== 'undefined' && currentPlayingVideoId && currentPlayingVideoId !== this.videoId) {
        return false;
      }
      return true;
    }

    check(currentTime, duration) {
      if (!this.segments.length) return false;
      if (!this._isPlaying()) return false;
      if (!this._matchesCurrentVideo()) return false;

      const t = (typeof currentTime === 'number' && !isNaN(currentTime)) ? currentTime : this._getCurrentTime();
      if (typeof t !== 'number' || isNaN(t) || t < 0) return false;

      // 1. Проверяем статус подтверждения предыдущей перемотки
      if (this._isSeeking && this._pendingSkip) {
        const seg = this._pendingSkip;
        if (t >= (seg.end - 0.5) || t >= (seg.start + (seg.end - seg.start) * 0.9)) {
          this._confirmSkip(seg);
          return true;
        }
        // Таймаут ожидания перемотки (2.5 сек)
        if (Date.now() - this._seekTimestamp > 2500) {
          this._isSeeking = false;
          this._pendingSkip = null;
        }
        return false;
      }

      // 2. Поиск сегмента для пропуска
      const seg = this.segments.find(
        s => !this.ignored.has(s.id) &&
             !this.undone.has(s.id) &&
             t >= (s.start - 0.2) &&
             t < (s.end - 0.3)
      );
      if (!seg) return false;

      // Начинаем перемотку
      this._isSeeking = true;
      this._pendingSkip = seg;
      this._seekTimestamp = Date.now();
      this.ignored.add(seg.id);

      this._seekTo(seg.end);

      // Если время мгновенно обновилось или seek синхронный
      const afterTime = this._getCurrentTime();
      if (typeof afterTime === 'number' && (afterTime >= (seg.end - 0.5) || afterTime >= (seg.start + (seg.end - seg.start) * 0.9))) {
        this._confirmSkip(seg);
      }
      return true;
    }

    _confirmSkip(seg) {
      this._isSeeking = false;
      this._pendingSkip = null;
      this.lastSkip = seg;
      this.count += 1;
      writeCount(this.count);
      console.log(`[SponsorBlock] Auto-skipped ${seg.category} (${seg.start.toFixed(1)}s -> ${seg.end.toFixed(1)}s)`);
      this.onSkip({
        category: seg.category,
        from: seg.start,
        to: seg.end,
        count: this.count,
        segment: seg
      });
    }

    _tick() {
      this.check();
    }

    undo() {
      if (!this.lastSkip) return null;
      const seg = this.lastSkip;

      // Добавляем в undone и ignored, чтобы при дальнейшем воспроизведении сегмент НЕ пропускался повторно
      this.undone.add(seg.id);
      this.ignored.add(seg.id);

      // Перематываем на начало сегмента
      this._seekTo(Math.max(0, seg.start));

      this.count = Math.max(0, this.count - 1);
      writeCount(this.count);

      const undoneSeg = this.lastSkip;
      this.lastSkip = null;
      this._isSeeking = false;
      this._pendingSkip = null;

      console.log(`[SponsorBlock] Undo skip for ${seg.category} (${seg.start.toFixed(1)}s)`);
      this.onUndo({
        category: seg.category,
        from: seg.start,
        to: seg.end,
        count: this.count,
        segment: undoneSeg
      });
      return undoneSeg;
    }
  }

  // Статические ссылки для прямого вызова без new SponsorBlock
  SponsorBlock.categories = DEFAULT_CATEGORIES;
  SponsorBlock.fetchSegments = fetchSponsorSegments;
  SponsorBlock.load = (videoId, categories, signal) => fetchSponsorSegments(videoId, categories || DEFAULT_CATEGORIES, signal);
  SponsorBlock.matchesDuration = (seg, dur) => {
    return seg.end <= dur + 1.5 && (!seg.videoDuration || Math.abs(seg.videoDuration - dur) <= 2);
  };

  window.SponsorBlock = SponsorBlock;
})();
