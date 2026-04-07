import type { ExtractionResult } from '../types/index.js';

/**
 * Extract transcript from a YouTube video using the innertube captions endpoint.
 * No ytdl-core dependency needed — we fetch the video page, parse the captions
 * track URL from the embedded player config, then fetch the timed text XML.
 */
export async function extractYoutube(input: string): Promise<ExtractionResult> {
    const videoId = parseVideoId(input);
    if (!videoId) throw new Error(`Invalid YouTube URL or ID: ${input}`);

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    /** Fetch the watch page to extract player config. */
    const pageRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumen/1.0)' },
    });
    if (!pageRes.ok) throw new Error(`Failed to fetch YouTube page: ${pageRes.status}`);

    const html = await pageRes.text();

    const title =
        html
            .match(/<title>(.*?)<\/title>/)?.[1]
            ?.replace(' - YouTube', '')
            .trim() || `YouTube ${videoId}`;

    const channel = html.match(/"ownerChannelName":"([^"]+)"/)?.[1] || null;

    /** Extract captions track URL from the player response JSON. */
    const captionsMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionsMatch) throw new Error(`No captions available for video: ${videoId}`);

    let tracks: { baseUrl: string; languageCode: string; name?: { simpleText?: string } }[];
    try {
        tracks = JSON.parse(captionsMatch[1]);
    } catch {
        throw new Error(`Failed to parse caption tracks for video: ${videoId}`);
    }

    if (tracks.length === 0) throw new Error(`No caption tracks found for video: ${videoId}`);

    /** Prefer English, fall back to first available track. */
    const track =
        tracks.find((t) => t.languageCode === 'en') || tracks.find((t) => t.languageCode.startsWith('en')) || tracks[0];

    /** Fetch the timed text XML and extract plain text. */
    const captionRes = await fetch(track.baseUrl);
    if (!captionRes.ok) throw new Error(`Failed to fetch captions: ${captionRes.status}`);

    const xml = await captionRes.text();
    const transcript = parseTimedText(xml);

    if (!transcript.trim()) throw new Error(`Empty transcript for video: ${videoId}`);

    return {
        title,
        content: transcript,
        url,
        source_type: 'youtube',
        language: track.languageCode || null,
        metadata: {
            video_id: videoId,
            channel,
            caption_language: track.languageCode,
            caption_name: track.name?.simpleText || null,
        },
    };
}

/** Parse a YouTube video ID from various URL formats or a raw ID. */
function parseVideoId(input: string): string | null {
    if (/^[\w-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
        if (url.hostname.includes('youtube.com')) return url.searchParams.get('v');
    } catch {
        /** Not a valid URL. */
    }

    return null;
}

/** Extract plain text from YouTube timed text XML, joining segments with spaces. */
function parseTimedText(xml: string): string {
    const segments = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
        .map((m) => m[1])
        .map(decodeXmlEntities)
        .map((s) => s.trim())
        .filter(Boolean);
    return segments.join(' ');
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/\n/g, ' ');
}
