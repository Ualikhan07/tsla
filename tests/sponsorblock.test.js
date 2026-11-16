const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = readFileSync(require.resolve('../sponsorblock.js'), 'utf8');
const videoId = 'dQw4w9WgXcQ';

function createContext(fetch) {
    const storage = new Map();
    const context = vm.createContext({
        document: { readyState: 'loading', getElementById: () => null, addEventListener() {} },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        addEventListener() {},
        URLSearchParams, TextEncoder, crypto: webcrypto, fetch,
        AbortController, setTimeout, clearTimeout, console
    });
    context.window = context;
    vm.runInContext(source, context);
    return context;
}

test('requests a hash prefix and keeps skip segments for the exact video and selected category', async () => {
    const context = createContext(async address => {
        const url = new URL(address);
        assert.equal(url.origin, 'https://sponsor.ajay.app');
        assert.equal(url.pathname, '/api/skipSegments/5f6b');
        assert.equal(url.searchParams.get('categories'), '["intro"]');
        assert.equal(url.searchParams.get('actionTypes'), '["skip"]');
        const intro = { category: 'intro', actionType: 'skip', UUID: 'intro', segment: [0, 5], videoDuration: 100 };
        return {
            ok: true,
            json: async () => [
                { videoID: 'anotherId12', segments: [intro] },
                { videoID: videoId, segments: [
                    intro,
                    { ...intro, category: 'sponsor' },
                    { ...intro, actionType: 'mute' },
                    { ...intro, segment: [-1, 5] }
                ] }
            ]
        };
    });
    const { load, matchesDuration } = context.SponsorBlock;
    const segments = await load(videoId, ['intro']);
    assert.deepEqual(Array.from(segments, segment => segment.id), ['intro']);
    assert.equal(matchesDuration(segments[0], 100.4), true);
    assert.equal(matchesDuration(segments[0], 90), false);
});

test('distinguishes no segments from an API error', async () => {
    const context = createContext(async () => ({ status: 404 }));
    assert.equal((await context.SponsorBlock.load(videoId, ['intro'])).length, 0);
    context.fetch = async () => ({ status: 503 });
    await assert.rejects(context.SponsorBlock.load(videoId, ['intro']), /HTTP 503/);
    assert.equal((await context.SponsorBlock.load(videoId, [])).length, 0);
});

test('skips once, saves the count, and allows undo without skipping again', () => {
    const context = createContext();
    vm.runInContext(readFileSync(require.resolve('../carplay.js'), 'utf8'), context);
    vm.runInContext(`
        const seeks = [];
        currentPlayingVideoId = "${videoId}";
        ytPlayer = {
            getVideoData: () => ({ video_id: currentPlayingVideoId }),
            getPlayerState: () => 1,
            seekTo: time => seeks.push(time)
        };
        playbackFeatures.currentSegments = [{ start: 5, end: 10, id: 'intro', category: 'intro' }];
        playbackFeatures.isAdAccelerated = true;
        playbackFeatures.checkAndSkip(5, 120);
        playbackFeatures.isAdAccelerated = false;
        playbackFeatures.checkAndSkip(5, 120);
        playbackFeatures.checkAndSkip(5, 120);
        const countAfterSkip = localStorage.getItem('sb_count');
        playbackFeatures.undoLastSkip();
        playbackFeatures.checkAndSkip(5, 120);
    `, context);
    assert.deepEqual(Array.from(vm.runInContext('seeks', context)), [10, 5]);
    assert.equal(vm.runInContext('countAfterSkip', context), '1');
    assert.equal(context.localStorage.getItem('sb_count'), '0');
});

test('discard a response from a video that has already been replaced', async () => {
    const context = createContext();
    vm.runInContext(readFileSync(require.resolve('../carplay.js'), 'utf8'), context);
    const requests = [];
    context.SponsorBlock.load = (id, categories, signal) =>
        new Promise(resolve => requests.push({ resolve, signal }));
    const first = vm.runInContext('playbackFeatures.fetchSponsorSegments("dQw4w9WgXcQ")', context);
    const second = vm.runInContext('playbackFeatures.fetchSponsorSegments("anotherId12")', context);
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve([{ id: 'new' }]);
    await second;
    requests[0].resolve([{ id: 'old' }]);
    await first;
    assert.equal(vm.runInContext('playbackFeatures.currentSegments[0].id', context), 'new');
});

test('SponsorBlock class instance handles load race conditions and aborts previous request', async () => {
    const context = createContext();
    const sb = new context.SponsorBlock(null, { categories: ['intro'] });
    const requests = [];
    context.SponsorBlock.fetchSegments = (id, categories, signal) =>
        new Promise(resolve => requests.push({ id, resolve, signal }));

    const p1 = sb.load('video111111');
    const p2 = sb.load('video222222');

    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve([{ id: 'seg2', start: 0, end: 5, category: 'intro' }]);
    await p2;
    requests[0].resolve([{ id: 'seg1', start: 0, end: 5, category: 'intro' }]);
    await p1;

    assert.equal(sb.segments.length, 1);
    assert.equal(sb.segments[0].id, 'seg2');
});

test('SponsorBlock class instance undo prevents re-skipping on subsequent playback checks', () => {
    const context = createContext();
    let curTime = 0;
    const seeks = [];
    const skippedEvents = [];
    const undoEvents = [];

    const sb = new context.SponsorBlock(null, {
        categories: ['sponsor'],
        getCurrentTime: () => curTime,
        seekTo: (t) => { seeks.push(t); curTime = t; },
        onSkip: (ev) => skippedEvents.push(ev),
        onUndo: (ev) => undoEvents.push(ev)
    });

    sb.segments = [{ id: 'sponsor1', start: 10, end: 25, category: 'sponsor' }];

    // 1. Playback before segment
    curTime = 5;
    sb.check(curTime);
    assert.equal(seeks.length, 0);

    // 2. Playback enters segment -> triggers seek to end
    curTime = 10.2;
    sb.check(curTime);
    assert.deepEqual(seeks, [25]);
    assert.equal(skippedEvents.length, 1);
    assert.equal(sb.count, 1);

    // 3. User clicks Undo -> seeks back to start
    sb.undo();
    assert.deepEqual(seeks, [25, 10]);
    assert.equal(undoEvents.length, 1);
    assert.equal(sb.count, 0);

    // 4. Video resumes from 10 and plays forward -> MUST NOT RE-SKIP!
    curTime = 10.5;
    sb.check(curTime);
    curTime = 15;
    sb.check(curTime);
    curTime = 24.5;
    sb.check(curTime);

    // Seeks must still only be [25, 10]
    assert.deepEqual(seeks, [25, 10]);
    assert.equal(skippedEvents.length, 1);
    assert.equal(sb.count, 0);
});
