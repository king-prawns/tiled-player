import IEncodedChunk from '@interfaces/IEncodedChunk';

type EncoderType = 'video' | 'audio';

interface VideoEncoderOptions {
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
}

interface AudioEncoderOptions {
  sampleRate?: number;
  numberOfChannels?: number;
  bitrate?: number;
}

class Encoder {
  #encoder: VideoEncoder | AudioEncoder | null = null;
  #type: EncoderType;

  #onChunkCallback: ((chunk: IEncodedChunk) => void) | null = null;
  #frameCounter: number = 0;

  constructor(type: EncoderType = 'video') {
    this.#type = type;
  }

  onChunk = (callback: (chunk: IEncodedChunk) => void): void => {
    this.#onChunkCallback = callback;
  };

  init = async (options?: VideoEncoderOptions | AudioEncoderOptions): Promise<void> => {
    if (this.#type === 'video') {
      await this.#initVideo(options as VideoEncoderOptions);
    } else {
      await this.#initAudio(options as AudioEncoderOptions);
    }
  };

  encode = (frame: VideoFrame | AudioData): void => {
    if (this.#type === 'video') {
      this.#encodeVideo(frame as VideoFrame);
    } else {
      this.#encodeAudio(frame as AudioData);
    }
  };

  flush = async (): Promise<void> => {
    await this.#encoder?.flush();
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

  #initVideo = async (options?: VideoEncoderOptions): Promise<void> => {
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

  #initAudio = async (options?: AudioEncoderOptions): Promise<void> => {
    const init: AudioEncoderInit = {
      output: this.#handleChunk,
      error: (e: DOMException) => {
        // eslint-disable-next-line no-console
        console.error('[Encoder:audio] Error:', e.message);
      }
    };

    const config: AudioEncoderConfig = {
      codec: 'opus',
      sampleRate: options?.sampleRate ?? 48000,
      numberOfChannels: options?.numberOfChannels ?? 2,
      bitrate: options?.bitrate ?? 128000
    };

    const {supported} = await AudioEncoder.isConfigSupported(config);
    if (supported) {
      this.#encoder = new AudioEncoder(init);
      this.#encoder.configure(config);
    } else {
      // eslint-disable-next-line no-console
      console.error('[Encoder:audio] Configuration not supported:', config);
    }
  };

  #encodeVideo = (videoFrame: VideoFrame): void => {
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

  #encodeAudio = (audioData: AudioData): void => {
    if (!this.#encoder) return;

    if (this.#encoder.encodeQueueSize > 10) {
      // eslint-disable-next-line no-console
      console.warn('[Encoder:audio] Dropping audio, queue full');
      audioData.close();
    } else {
      (this.#encoder as AudioEncoder).encode(audioData);
      audioData.close();
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
