import Decoder from '@decoder/decoder';

import StreamDownloader, {SegmentReady} from './streamDownloader';

interface StreamConfig {
  mpdUrl: string;
  signal: AbortSignal;
}

class StreamManager {
  #decoder: Decoder;
  #downloader: StreamDownloader;
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
    return this.#ended && this.#downloader.isEnded && this.#decoder.videoFrames.length === 0;
  }

  start = (): void => {
    this.#downloader.start();
  };

  destroy = (): void => {
    this.#ended = true;
    this.#downloader.destroy();
    this.#decoder.destroy();
  };

  #onSegmentReady = (): void => {
    const segment: SegmentReady | undefined = this.#downloader.getReadySegment();
    if (segment) {
      this.#decoder.feedData(segment.data, segment.type);
    }
  };
}

export default StreamManager;
