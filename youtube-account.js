const youtubeAccount = (() => {
    let cachedFeed;

    async function request(token, resource, params) {
        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(data.error?.errors?.[0]?.reason || `YouTube HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    async function readFeed(token) {
        const channels = [];
        let pageToken;
        do {
            const data = await request(token, 'subscriptions', {
                part: 'snippet', mine: 'true', maxResults: '50',
                ...(pageToken ? { pageToken } : {})
            });
            for (const { snippet } of data.items || []) {
                const id = snippet?.resourceId?.channelId;
                if (!id) continue;
                channels.push({
                    id,
                    title: snippet.title || 'Канал',
                    avatar: snippet.thumbnails?.default?.url || ''
                });
            }
            pageToken = data.nextPageToken;
        } while (pageToken);

        const videos = [];
        const failedChannels = new Set();
        for (let offset = 0; offset < channels.length; offset += 8) {
            await Promise.all(channels.slice(offset, offset + 8).map(async channel => {
                try {
                    const data = await request(token, 'playlistItems', {
                        part: 'snippet,contentDetails',
                        playlistId: channel.id.replace(/^UC/, 'UU'),
                        maxResults: '4'
                    });
                    for (const item of data.items || []) {
                        const videoId = item.contentDetails?.videoId;
                        const title = item.snippet?.title;
                        if (!videoId || !title || ['Private video', 'Deleted video'].includes(title)) continue;
                        videos.push({
                            videoId,
                            channelId: channel.id,
                            title,
                            author: channel.title,
                            publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
                            thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                            durationSec: 0
                        });
                    }
                } catch (error) {
                    if (error.status !== 404) failedChannels.add(channel.id);
                }
            }));
        }

        videos.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
        return { channels, videos, failedChannels };
    }

    function feed(token, force = false) {
        if (!force && cachedFeed?.token === token && Date.now() < cachedFeed.expires) {
            return cachedFeed.promise;
        }

        const entry = { token, expires: Infinity };
        cachedFeed = entry;
        entry.promise = readFeed(token).then(result => {
            entry.expires = Date.now() + (result.failedChannels.size ? 30000 : 300000);
            return result;
        }).catch(error => {
            if (cachedFeed === entry) cachedFeed = undefined;
            throw error;
        });
        return entry.promise;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    return { feed, request, escapeHtml };
})();
