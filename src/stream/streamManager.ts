import Decoder, {type AudioSourceId} from '@decoder/decoder';
import generate from '@generator/generator';

interface StreamConfig {
  mpdUrl: string;
  sourceId: AudioSourceId;
  signal?: AbortSignal;
}

/**
 * StreamManager - Manages DASH segment fetching for a single stream
 * MSEPlayer controls when to fetch via fetchNextChunk()
 */
class StreamManager {
  #config: StreamConfig;
  #decoder: Decoder;
  #generator: AsyncGenerator<{data: Uint8Array; type: 'video' | 'audio'}> | null = null;
  #isFetching: boolean = false;
  #isEnded: boolean = false;

  constructor(config: StreamConfig) {
    this.#config = config;
    this.#decoder = new Decoder(config.sourceId, config.signal);
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
        this.#decoder.setEnded();
        // eslint-disable-next-line no-console
        console.log(`[StreamManager] Stream ${this.#config.sourceId} ended`);

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

  /**
   * Fetch multiple chunks at once (for initial buffering)
   */
  fetchChunks = async (count: number): Promise<number> => {
    let fetched: number = 0;
    for (let i: number = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const hasMore: boolean = await this.fetchNextChunk();
      if (!hasMore) break;
      fetched++;
    }

    return fetched;
  };

  destroy = (): void => {
    this.#decoder.destroy();
    this.#isEnded = true;
  };
}

export default StreamManager;
