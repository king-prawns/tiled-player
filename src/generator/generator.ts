import IEncodedChunk from '@interfaces/IEncodedChunk';
import parseMPD, {DashSegment, ParsedDash} from '@parser/dash';

interface GeneratorOptions {
  mpdUrl: string;
  signal?: AbortSignal;
  preferOpus?: boolean;
  onVideoChunk?: (chunk: IEncodedChunk) => void;
  onAudioChunk?: (chunk: IEncodedChunk) => void;
}

export interface Chunk {
  type: 'video' | 'audio';
  data: Uint8Array;
  timestamp: number;
  isInit: boolean;
}

/**
 * Fetch a segment and return its data
 */
async function fetchSegment(url: string): Promise<Uint8Array> {
  const response: Response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
  }

  const buffer: ArrayBuffer = await response.arrayBuffer();

  return new Uint8Array(buffer);
}

/**
 * Generator - fetches MPD manifest and yields video/audio chunks
 */
async function* generate(options: GeneratorOptions): AsyncGenerator<Chunk> {
  const mpdUrl: string = options.mpdUrl;

  // eslint-disable-next-line no-console
  console.log('[Generator] Fetching MPD manifest:', mpdUrl);

  const parsed: ParsedDash = await parseMPD(mpdUrl, options.preferOpus);
  const {videoSegments, audioSegments, videoInitUrl, audioInitUrl, audioCodec} = parsed;

  // eslint-disable-next-line no-console
  console.log(
    `[Generator] Found ${videoSegments.length} video segments, ${audioSegments.length} audio segments`
  );
  // eslint-disable-next-line no-console
  if (audioCodec) console.log(`[Generator] Audio codec: ${audioCodec}`);

  // Fetch and yield video init segment
  if (videoInitUrl) {
    // eslint-disable-next-line no-console
    console.log('[Generator] Fetching video init segment:', videoInitUrl);
    const initData: Uint8Array = await fetchSegment(videoInitUrl);
    yield {type: 'video', data: initData, timestamp: 0, isInit: true};
  }

  // Fetch and yield audio init segment
  if (audioInitUrl) {
    // eslint-disable-next-line no-console
    console.log('[Generator] Fetching audio init segment:', audioInitUrl);
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
      console.log(`[Generator] Fetching video segment ${i + 1}/${videoSegments.length}`);
      // eslint-disable-next-line no-await-in-loop
      const data: Uint8Array = await fetchSegment(seg.url);

      const chunk: Chunk = {
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
      console.log(`[Generator] Fetching audio segment ${i + 1}/${audioSegments.length}`);
      // eslint-disable-next-line no-await-in-loop
      const data: Uint8Array = await fetchSegment(seg.url);

      const chunk: Chunk = {
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
          key: i === 0, // First segment is keyframe
          data
        });
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log('[Generator] Finished fetching all segments');
}

export default generate;
