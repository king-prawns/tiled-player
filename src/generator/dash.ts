import IEncodedAudioChunk from '@interfaces/IEncodedAudioChunk';
import IEncodedChunk from '@interfaces/IEncodedChunk';

// Sample DASH MPD URL (Big Buck Bunny - clear, no DRM)
const DEFAULT_MPD_URL: string = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';

interface DashSegment {
  url: string;
  timestamp: number;
  duration: number;
  byteRange?: string; // For SegmentBase (on-demand)
}

interface DashChunk {
  type: 'video' | 'audio';
  data: Uint8Array;
  timestamp: number;
  isInit: boolean;
}

interface ParsedDash {
  videoSegments: Array<DashSegment>;
  audioSegments: Array<DashSegment>;
  videoInitUrl: string;
  audioInitUrl: string;
  videoInitRange?: string;
  audioInitRange?: string;
  isOnDemand: boolean;
  audioCodec?: string;
}

/**
 * Parse MPD manifest and extract segment URLs
 * Supports both SegmentTemplate (live/chunked) and SegmentBase (on-demand)
 * Prefers Opus audio over AAC when available
 */
async function parseMPD(mpdUrl: string, preferOpus: boolean = false): Promise<ParsedDash> {
  const response: Response = await fetch(mpdUrl);
  const mpdText: string = await response.text();
  const parser: DOMParser = new DOMParser();
  const mpd: Document = parser.parseFromString(mpdText, 'application/xml');

  const baseUrl: string = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);

  // Find video AdaptationSet - prefer MP4/H.264 for better compatibility
  const videoAdaptation: Element | null = mpd.querySelector(
    'AdaptationSet[mimeType="video/mp4"], AdaptationSet[contentType="video"]'
  );

  // Find audio AdaptationSet - prefer Opus if requested
  let audioAdaptation: Element | null = null;
  if (preferOpus) {
    // Try to find Opus audio first
    const allAudioAdaptations = Array.from(
      mpd.querySelectorAll('AdaptationSet[contentType="audio"], AdaptationSet[mimeType^="audio"]')
    );
    for (const adapt of allAudioAdaptations) {
      const rep = adapt.querySelector('Representation');
      const codec = rep?.getAttribute('codecs') || '';
      if (codec.toLowerCase().includes('opus')) {
        audioAdaptation = adapt;
        break;
      }
    }
  }
  // Fallback to any audio
  if (!audioAdaptation) {
    audioAdaptation = mpd.querySelector(
      'AdaptationSet[mimeType="audio/mp4"], AdaptationSet[mimeType="audio/webm"], AdaptationSet[contentType="audio"]'
    );
  }

  const result: ParsedDash = {
    videoSegments: [],
    audioSegments: [],
    videoInitUrl: '',
    audioInitUrl: '',
    isOnDemand: false,
    audioCodec: undefined
  };

  // Parse video segments
  if (videoAdaptation) {
    const representation: Element | null = videoAdaptation.querySelector('Representation');
    if (representation) {
      const segmentTemplate: Element | null =
        representation.querySelector('SegmentTemplate') ?? videoAdaptation.querySelector('SegmentTemplate');

      if (segmentTemplate) {
        const initTemplate: string = segmentTemplate.getAttribute('initialization') ?? '';
        const mediaTemplate: string = segmentTemplate.getAttribute('media') ?? '';
        const timescale: number = parseInt(segmentTemplate.getAttribute('timescale') ?? '1', 10);
        const duration: number = parseInt(segmentTemplate.getAttribute('duration') ?? '0', 10);
        const startNumber: number = parseInt(segmentTemplate.getAttribute('startNumber') ?? '1', 10);
        const repId: string = representation.getAttribute('id') ?? '';

        // Replace all $RepresentationID$ in init URL
        result.videoInitUrl = baseUrl + initTemplate.replace(/\$RepresentationID\$/g, repId);

        // Get segment timeline or use duration-based segments
        const timeline: Element | null = segmentTemplate.querySelector('SegmentTimeline');
        if (timeline) {
          // SegmentTimeline mode (using $Time$)
          const segments: NodeListOf<Element> = timeline.querySelectorAll('S');
          let time: number = 0;
          segments.forEach((s: Element) => {
            const t: number = parseInt(s.getAttribute('t') ?? String(time), 10);
            const d: number = parseInt(s.getAttribute('d') ?? '0', 10);
            const r: number = parseInt(s.getAttribute('r') ?? '0', 10);

            for (let i: number = 0; i <= r; i++) {
              const segUrl: string =
                baseUrl +
                mediaTemplate.replace(/\$RepresentationID\$/g, repId).replace('$Time$', String(t + i * d));
              result.videoSegments.push({
                url: segUrl,
                timestamp: ((t + i * d) / timescale) * 1_000_000,
                duration: (d / timescale) * 1_000_000
              });
              if (result.videoSegments.length >= 10) break;
            }
            time = t + (r + 1) * d;
            if (result.videoSegments.length >= 10) return;
          });
        } else if (duration > 0) {
          // Duration-based mode (using $Number$)
          const segmentDurationSec: number = duration / timescale;
          for (let num: number = startNumber; num < startNumber + 10; num++) {
            const segUrl: string =
              baseUrl +
              mediaTemplate.replace(/\$RepresentationID\$/g, repId).replace('$Number$', String(num));
            result.videoSegments.push({
              url: segUrl,
              timestamp: (num - startNumber) * segmentDurationSec * 1_000_000,
              duration: segmentDurationSec * 1_000_000
            });
          }
        }
      }
    }
  }

  // Parse audio segments (similar logic)
  if (audioAdaptation) {
    const representation: Element | null = audioAdaptation.querySelector('Representation');
    if (representation) {
      result.audioCodec = representation.getAttribute('codecs') ?? undefined;
      const segmentTemplate: Element | null =
        representation.querySelector('SegmentTemplate') ?? audioAdaptation.querySelector('SegmentTemplate');

      if (segmentTemplate) {
        const initTemplate: string = segmentTemplate.getAttribute('initialization') ?? '';
        const mediaTemplate: string = segmentTemplate.getAttribute('media') ?? '';
        const timescale: number = parseInt(segmentTemplate.getAttribute('timescale') ?? '1', 10);
        const duration: number = parseInt(segmentTemplate.getAttribute('duration') ?? '0', 10);
        const startNumber: number = parseInt(segmentTemplate.getAttribute('startNumber') ?? '1', 10);
        const repId: string = representation.getAttribute('id') ?? '';

        // Replace all $RepresentationID$ in init URL
        result.audioInitUrl = baseUrl + initTemplate.replace(/\$RepresentationID\$/g, repId);

        const timeline: Element | null = segmentTemplate.querySelector('SegmentTimeline');
        if (timeline) {
          // SegmentTimeline mode (using $Time$)
          const segments: NodeListOf<Element> = timeline.querySelectorAll('S');
          let time: number = 0;
          segments.forEach((s: Element) => {
            const t: number = parseInt(s.getAttribute('t') ?? String(time), 10);
            const d: number = parseInt(s.getAttribute('d') ?? '0', 10);
            const r: number = parseInt(s.getAttribute('r') ?? '0', 10);

            for (let i: number = 0; i <= r; i++) {
              const segUrl: string =
                baseUrl +
                mediaTemplate.replace(/\$RepresentationID\$/g, repId).replace('$Time$', String(t + i * d));
              result.audioSegments.push({
                url: segUrl,
                timestamp: ((t + i * d) / timescale) * 1_000_000,
                duration: (d / timescale) * 1_000_000
              });
              if (result.audioSegments.length >= 10) break;
            }
            time = t + (r + 1) * d;
            if (result.audioSegments.length >= 10) return;
          });
        } else if (duration > 0) {
          // Duration-based mode (using $Number$)
          const segmentDurationSec: number = duration / timescale;
          for (let num: number = startNumber; num < startNumber + 10; num++) {
            const segUrl: string =
              baseUrl +
              mediaTemplate.replace(/\$RepresentationID\$/g, repId).replace('$Number$', String(num));
            result.audioSegments.push({
              url: segUrl,
              timestamp: (num - startNumber) * segmentDurationSec * 1_000_000,
              duration: segmentDurationSec * 1_000_000
            });
          }
        }
      }
    }
  }

  return result;
}

/**
 * Fetch a segment and return its data
 */
async function fetchSegment(url: string): Promise<Uint8Array> {
  const response: Response = await fetch(url);
  const buffer: ArrayBuffer = await response.arrayBuffer();

  return new Uint8Array(buffer);
}

export interface DashGeneratorOptions {
  mpdUrl?: string;
  signal?: AbortSignal;
  preferOpus?: boolean;
  onVideoChunk?: (chunk: IEncodedChunk) => void;
  onAudioChunk?: (chunk: IEncodedAudioChunk) => void;
}

/**
 * DASH Generator - fetches MPD manifest and yields video/audio chunks
 * Retrieves 10 video and 10 audio segments from a clear (non-DRM) DASH stream
 */
async function* generateDash(options: DashGeneratorOptions = {}): AsyncGenerator<DashChunk> {
  const mpdUrl: string = options.mpdUrl ?? DEFAULT_MPD_URL;

  // eslint-disable-next-line no-console
  console.log('[DASH] Fetching MPD manifest:', mpdUrl);

  const parsed: ParsedDash = await parseMPD(mpdUrl, options.preferOpus);
  const {videoSegments, audioSegments, videoInitUrl, audioInitUrl, audioCodec} = parsed;

  // eslint-disable-next-line no-console
  console.log(`[DASH] Found ${videoSegments.length} video segments, ${audioSegments.length} audio segments`);
  // eslint-disable-next-line no-console
  if (audioCodec) console.log(`[DASH] Audio codec: ${audioCodec}`);

  // Fetch and yield video init segment
  if (videoInitUrl) {
    // eslint-disable-next-line no-console
    console.log('[DASH] Fetching video init segment:', videoInitUrl);
    const initData: Uint8Array = await fetchSegment(videoInitUrl);
    yield {type: 'video', data: initData, timestamp: 0, isInit: true};
  }

  // Fetch and yield audio init segment
  if (audioInitUrl) {
    // eslint-disable-next-line no-console
    console.log('[DASH] Fetching audio init segment:', audioInitUrl);
    const initData: Uint8Array = await fetchSegment(audioInitUrl);
    yield {type: 'audio', data: initData, timestamp: 0, isInit: true};
  }

  // Fetch video and audio segments interleaved
  const maxSegments: number = Math.max(videoSegments.length, audioSegments.length);

  for (let i: number = 0; i < maxSegments; i++) {
    if (options.signal?.aborted) break;

    // Fetch video segment
    if (i < videoSegments.length) {
      const seg: DashSegment = videoSegments[i];
      // eslint-disable-next-line no-console
      console.log(`[DASH] Fetching video segment ${i + 1}/${videoSegments.length}`);
      // eslint-disable-next-line no-await-in-loop
      const data: Uint8Array = await fetchSegment(seg.url);

      const chunk: DashChunk = {
        type: 'video',
        data,
        timestamp: seg.timestamp,
        isInit: false
      };
      yield chunk;

      // Call callback if provided
      if (options.onVideoChunk) {
        options.onVideoChunk({
          timestamp: seg.timestamp,
          key: i === 0, // First segment is keyframe
          data
        });
      }
    }

    // Fetch audio segment
    if (i < audioSegments.length) {
      const seg: DashSegment = audioSegments[i];
      // eslint-disable-next-line no-console
      console.log(`[DASH] Fetching audio segment ${i + 1}/${audioSegments.length}`);
      // eslint-disable-next-line no-await-in-loop
      const data: Uint8Array = await fetchSegment(seg.url);

      const chunk: DashChunk = {
        type: 'audio',
        data,
        timestamp: seg.timestamp,
        isInit: false
      };
      yield chunk;

      // Call callback if provided
      if (options.onAudioChunk) {
        options.onAudioChunk({
          timestamp: seg.timestamp,
          duration: seg.duration,
          data
        });
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log('[DASH] Finished fetching all segments');
}

export default generateDash;
export {DashChunk, DashSegment, parseMPD};
