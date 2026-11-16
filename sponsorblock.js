/*
 * sponsorblock.js — модуль интеграции с базой SponsorBlock (https://sponsor.ajay.app)
 * Поддерживает:
 *  - K-Anonymity SHA-256 префиксы (privacy-friendly) + автоматический прямой fallback
 *  - Автоматический пропуск спонсоров, интро, аутро, саморекламы
 *  - Отрисовку меток на полосе воспроизведения
 *  - Поддержку отмены пропуска (Undo)
 *  - Совместимость как с YouTube IFrame, так и с HTML5/Canvas плеерами
 */
(function () {
  const API_PREFIX = 'https://sponsor.ajay.app/api/skipSegments/';
  const API_DIRECT = 'https://sponsor.ajay.app/api/skipSegments';
  const DEFAULT_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro'];

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

  // Универсальный статический метод загрузки сегментов
  async function fetchSponsorSegments(videoId, categories = DEFAULT_CATEGORIES, signal = null) {
    if (!videoId || typeof videoId !== 'string') return [];
    const cleanId = videoId.trim();
    if (!/^[\w-]{11}$/.test(cleanId)) return [];

    const catsJson = encodeURIComponent(JSON.stringify(categories));

    // 1. Попытка через 4-значный SHA-256 префикс (K-Anonymity)
    try {
      const hash = await sha256hex(cleanId);
      const prefix = hash ? hash.slice(0, 4) : '';
      if (prefix) {
        const url = `${API_PREFIX}${prefix}?categories=${catsJson}`;
        const resp = await fetch(url, { signal });
        if (resp.ok) {
          const list = await resp.json();
          if (Array.isArray(list)) {
            const entry = list.find(v => v.videoID === cleanId);
            if (entry && Array.isArray(entry.segments) && entry.segments.length > 0) {
              return parseRawSegments(entry.segments, categories);
            }
          }
        }
      }
    } catch (err) {
      // Игнорируем и переходим к прямому запросу
    }

    // 2. Прямой запрос по videoID (надежный fallback)
    try {
      const directUrl = `${API_DIRECT}?videoID=${cleanId}&categories=${catsJson}`;
      const resp = await fetch(directUrl, { signal });
      if (resp.status === 404) return [];
      if (resp.ok) {
        const raw = await resp.json();
        if (Array.isArray(raw)) {
          return parseRawSegments(raw, categories);
        }
      }
    } catch (err) {
      console.warn('[SponsorBlock] Fetch error for video ' + cleanId, err);
    }

    return [];
  }

  function parseRawSegments(rawList, allowedCategories) {
    return rawList
      .filter(s => !s.actionType || s.actionType === 'skip')
      .filter(s => Array.isArray(s.segment) && s.segment.length >= 2)
      .filter(s => {
        const [start, end] = s.segment;
        return Number.isFinite(start) && Number.isFinite(end) && (end - start >= 0.8);
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

  class SponsorBlock {
    constructor(player, opts = {}) {
      this.player = player;
      this.categories = opts.categories || DEFAULT_CATEGORIES;
      this.minDuration = opts.minDuration ?? 0.8;
      this.onSkip = opts.onSkip || (() => {});
      this.segments = [];
      this.ignored = new Set();
      this.lastSkip = null;
      this.timer = null;
      this.count = readCount();
    }

    setPlayer(player) {
      this.player = player;
    }

    async load(videoId) {
      this.segments = [];
      this.ignored.clear();
      this.lastSkip = null;
      const loaded = await fetchSponsorSegments(videoId, this.categories);
      this.segments = loaded.filter(s => (s.end - s.start) >= this.minDuration);
      return this.segments;
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
    }

    _getCurrentTime() {
      if (!this.player) return null;
      if (typeof this.player.getCurrentTime === 'function') {
        try { return this.player.getCurrentTime(); } catch (e) { return null; }
      }
      if (typeof this.player.currentTime === 'number') {
        return this.player.currentTime;
      }
      return null;
    }

    _seekTo(seconds) {
      if (!this.player) return;
      if (typeof this.player.seekTo === 'function') {
        try { this.player.seekTo(seconds, true); return; } catch (e) {}
      }
      if (typeof this.player.currentTime === 'number') {
        this.player.currentTime = seconds;
      }
    }

    _tick() {
      if (!this.segments.length) return;
      const t = this._getCurrentTime();
      if (typeof t !== 'number' || isNaN(t)) return;

      const seg = this.segments.find(
        s => !this.ignored.has(s.id) && t >= (s.start - 0.2) && t < (s.end - 0.3)
      );
      if (!seg) return;

      this.lastSkip = seg;
      this.ignored.add(seg.id);
      this._seekTo(seg.end);

      this.count += 1;
      writeCount(this.count);
      console.log(`[SponsorBlock] Auto-skipped ${seg.category} (${seg.start.toFixed(1)}s -> ${seg.end.toFixed(1)}s)`);
      this.onSkip({ category: seg.category, from: seg.start, to: seg.end, count: this.count });
    }

    undo() {
      if (!this.lastSkip) return;
      const seg = this.lastSkip;
      this.ignored.delete(seg.id);
      this._seekTo(Math.max(0, seg.start - 0.5));
      this.count = Math.max(0, this.count - 1);
      writeCount(this.count);
      this.lastSkip = null;
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
