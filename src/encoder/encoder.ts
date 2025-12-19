import IEncodedChunk from '@interfaces/IEncodedChunk';

interface VideoEncoderOptions {
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
}

class Encoder {
  #encoder: VideoEncoder | AudioEncoder | null = null;

  #onChunkCallback: ((chunk: IEncodedChunk) => void) | null = null;
  #frameCounter: number = 0;

  constructor() {}

  onChunk = (callback: (chunk: IEncodedChunk) => void): void => {
    this.#onChunkCallback = callback;
  };

  init = async (options?: VideoEncoderOptions): Promise<void> => {
    const init: VideoEncoderInit = {
      output: this.#handleChunk,
      error: (e: DOMException) => {
        // eslint-disable-next-line no-console
        console.error('[Encoder:video] Error:', e.message);
      }
    };

    const config: VideoEncoderConfig = {
      codec: 'vp8',
      width: options?.width ?? 640,
      height: options?.height ?? 480,
      bitrate: options?.bitrate ?? 2_000_000,
      framerate: options?.framerate ?? 30
    };

    const {supported} = await VideoEncoder.isConfigSupported(config);
    if (supported) {
      this.#encoder = new VideoEncoder(init);
      this.#encoder.configure(config);
    } else {
      // eslint-disable-next-line no-console
      console.error('[Encoder:video] Configuration not supported:', config);
    }
  };

  encode = (videoFrame: VideoFrame): void => {
    if (!this.#encoder) return;

    if (this.#encoder.encodeQueueSize > 10) {
      // eslint-disable-next-line no-console
      console.warn('[Encoder:video] Dropping frame, queue full');
      videoFrame.close();
    } else {
      const keyFrame: boolean = this.#frameCounter % 150 === 0;
      (this.#encoder as VideoEncoder).encode(videoFrame, {keyFrame});
      videoFrame.close();
      this.#frameCounter++;
    }
  };

  destroy = (): void => {
    if (this.#encoder) {
      try {
        this.#encoder.close();
      } catch {
        // Ignore
      }
      this.#encoder = null;
    }
  };

  #handleChunk: EncodedVideoChunkOutputCallback = (chunk: EncodedVideoChunk | EncodedAudioChunk) => {
    const chunkData: Uint8Array = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkData);

    this.#onChunkCallback?.({
      timestamp: chunk.timestamp,
      key: chunk.type === 'key',
      data: chunkData
    });
  };
}

export default Encoder;
