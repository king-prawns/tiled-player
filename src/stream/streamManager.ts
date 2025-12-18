import Decoder from '@decoder/decoder';
import generate from '@generator/generator';

interface StreamConfig {
  mpdUrl: string;
  signal: AbortSignal;
}

/**
 * StreamManager - Manages DASH segment fetching for a single stream
 * Player controls when to fetch via fetchNextChunk()
 */
class StreamManager {
  #config: StreamConfig;
  #decoder: Decoder;
  #generator: AsyncGenerator<{data: Uint8Array; type: 'video' | 'audio'}> | null = null;
  #isFetching: boolean = false;
  #isEnded: boolean = false;

  constructor(config: StreamConfig) {
    this.#config = config;
    this.#decoder = new Decoder(config.signal);
  }

  get decoder(): Decoder {
    return this.#decoder;
  }

  get isEnded(): boolean {
    return this.#isEnded;
  }

  /**
   * Initialize the DASH generator (fetch manifest and prepare segment iterator)
   */
  init = (): void => {
    this.#generator = generate({
      mpdUrl: this.#config.mpdUrl,
      signal: this.#config.signal
    });
  };

  /**
   * Fetch next chunk from DASH stream
   * Returns true if more data is available, false if stream ended
   * Player calls this when buffer needs more data
   */
  fetchNextChunk = async (): Promise<boolean> => {
    if (this.#isEnded || !this.#generator || this.#config.signal?.aborted) {
      return false;
    }

    if (this.#isFetching) {
      return true; // Already fetching
    }

    this.#isFetching = true;

    try {
      const result: IteratorResult<{
        data: Uint8Array;
        type: 'video' | 'audio';
      }> = await this.#generator.next();

      if (result.done) {
        this.#isEnded = true;
        // eslint-disable-next-line no-console
        console.log(`[StreamManager] Stream "${this.#config.mpdUrl}" ended`);

        return false;
      }

      const chunk: {
        data: Uint8Array<ArrayBufferLike>;
        type: 'video' | 'audio';
      } = result.value;
      this.#decoder.feedData(chunk.data, chunk.type);

      return true;
    } finally {
      this.#isFetching = false;
    }
  };

  destroy = (): void => {
    this.#decoder.destroy();
    this.#isEnded = true;
  };
}

export default StreamManager;
