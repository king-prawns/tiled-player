import Decoder from '@decoder/decoder';

import StreamDownloader, {SegmentReady} from './streamDownloader';

interface StreamConfig {
  mpdUrl: string;
  signal: AbortSignal;
}

/**
 * StreamManager - Manages segment fetching and decoding
 */
class StreamManager {
  #decoder: Decoder;
  #downloader: StreamDownloader;
  #segmentsReceived: number = 0;
  #ended: boolean = false;

  constructor(config: StreamConfig) {
    this.#decoder = new Decoder(config.signal);
    this.#downloader = new StreamDownloader({
      mpdUrl: config.mpdUrl,
      signal: config.signal,
      onSegmentReady: this.#onSegmentReady
    });
  }

  get decoder(): Decoder {
    return this.#decoder;
  }

  get isEnded(): boolean {
    return this.#ended && this.#decoder.videoFrames.length === 0;
  }

  get segmentsReceived(): number {
    return this.#segmentsReceived;
  }

  start = (): void => {
    this.#downloader.start();
  };

  destroy = (): void => {
    this.#ended = true;
    this.#downloader.destroy();
    this.#decoder.destroy();
  };

  #onSegmentReady = (segment: SegmentReady): void => {
    this.#segmentsReceived++;
    // Feed directly to decoder - no queue needed
    this.#decoder.feedData(segment.data, segment.type);
  };
}

export default StreamManager;
