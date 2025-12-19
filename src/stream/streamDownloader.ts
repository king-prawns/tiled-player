import parseMPD, {DashSegment, ParsedDash} from '@parser/dash';

export type OnSegmentReadyCallback = (segment: SegmentReady) => void;

export interface SegmentReady {
  type: 'video' | 'audio';
  data: Uint8Array;
  timestamp: number;
  isInit: boolean;
}

interface StreamDownloaderConfig {
  mpdUrl: string;
  signal: AbortSignal;
  onSegmentReady: OnSegmentReadyCallback;
}

/**
 * StreamDownloader - Downloads manifest and segments
 * Calls onSegmentReady callback when a segment is downloaded
 */

class StreamDownloader {
  #config: StreamDownloaderConfig;
  #isEnded: boolean = false;
  #tickInterval: ReturnType<typeof setInterval> | null = null;
  #isFetching: boolean = false;
  #segmentGenerator: AsyncGenerator<SegmentReady> | null = null;
  #queue: Array<SegmentReady> = [];

  #videoSegments: Array<DashSegment> = [];
  #audioSegments: Array<DashSegment> = [];

  static readonly MAX_QUEUE_SIZE: number = 4;

  constructor(config: StreamDownloaderConfig) {
    this.#config = config;
  }

  get isEnded(): boolean {
    return this.#isEnded && this.#queue.length === 0;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  getReadySegment = (): SegmentReady | undefined => {
    return this.#queue.shift();
  };

  stop = (): void => {
    if (this.#tickInterval) {
      clearInterval(this.#tickInterval);
      this.#tickInterval = null;
    }
  };

  destroy = (): void => {
    this.stop();
    this.#isEnded = true;
    this.#queue = [];
  };

  start = (): void => {
    this.#fetchManifest().then(() => {
      this.#segmentGenerator = this.#fetchSegments();
    });

    this.#tickInterval = setInterval(this.#tick, 100);

    this.#tick();
  };

  #tick = (): void => {
    if (this.#isEnded || this.#config.signal.aborted || this.#isFetching) {
      return;
    }

    if (this.#queue.length >= StreamDownloader.MAX_QUEUE_SIZE) {
      return;
    }

    this.#fetchNextSegment();
  };

  #fetchNextSegment = async (): Promise<void> => {
    if (!this.#segmentGenerator || this.#isEnded || this.#config.signal.aborted) {
      return;
    }

    this.#isFetching = true;

    try {
      const result: IteratorResult<SegmentReady> = await this.#segmentGenerator.next();

      if (result.done) {
        this.#isEnded = true;
        this.stop();

        return;
      }

      this.#queue.push(result.value);
      this.#config.onSegmentReady(result.value);
    } catch (e) {
      if (!this.#config.signal.aborted) {
        // eslint-disable-next-line no-console
        console.error('[StreamDownloader] Fetch error:', e);
      }
    } finally {
      this.#isFetching = false;
    }
  };

  #fetchManifest = async (): Promise<void> => {
    const parsed: ParsedDash = await parseMPD(this.#config.mpdUrl);
    const {videoSegments, audioSegments, videoInitUrl, audioInitUrl} = parsed;

    this.#videoSegments = videoSegments;
    this.#audioSegments = audioSegments;

    if (videoInitUrl) {
      const initData: Uint8Array = await this.#fetchSegment(videoInitUrl);
      const segment: SegmentReady = {type: 'video', data: initData, timestamp: 0, isInit: true};
      this.#queue.push(segment);
      this.#config.onSegmentReady(segment);
    }

    if (audioInitUrl) {
      const initData: Uint8Array = await this.#fetchSegment(audioInitUrl);
      const segment: SegmentReady = {type: 'audio', data: initData, timestamp: 0, isInit: true};
      this.#queue.push(segment);
      this.#config.onSegmentReady(segment);
    }
  };

  async *#fetchSegments(): AsyncGenerator<SegmentReady> {
    // Fetch video and audio segments interleaved
    const maxSegments: number = Math.max(this.#videoSegments.length, this.#audioSegments.length);

    for (let i: number = 0; i < maxSegments; i++) {
      if (this.#config.signal?.aborted) break;

      // Fetch video segment
      if (i < this.#videoSegments.length) {
        const seg: DashSegment = this.#videoSegments[i];
        // eslint-disable-next-line no-console
        console.log(`[Generator] Fetching video segment ${i + 1}/${this.#videoSegments.length}`);
        // eslint-disable-next-line no-await-in-loop
        const data: Uint8Array = await this.#fetchSegment(seg.url);

        const chunk: SegmentReady = {
          type: 'video',
          data,
          timestamp: seg.timestamp,
          isInit: false
        };
        yield chunk;
      }

      // Fetch audio segment
      if (i < this.#audioSegments.length) {
        const seg: DashSegment = this.#audioSegments[i];
        // eslint-disable-next-line no-console
        console.log(`[Generator] Fetching audio segment ${i + 1}/${this.#audioSegments.length}`);
        // eslint-disable-next-line no-await-in-loop
        const data: Uint8Array = await this.#fetchSegment(seg.url);

        const chunk: SegmentReady = {
          type: 'audio',
          data,
          timestamp: seg.timestamp,
          isInit: false
        };
        yield chunk;
      }
    }

    // eslint-disable-next-line no-console
    console.log('[Generator] Finished fetching all segments');
  }

  /**
   * Fetch a segment and return its data
   */
  async #fetchSegment(url: string): Promise<Uint8Array> {
    const response: Response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
    }

    const buffer: ArrayBuffer = await response.arrayBuffer();

    return new Uint8Array(buffer);
  }
}

export default StreamDownloader;
