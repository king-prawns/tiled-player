import IEncodedChunk from '@interfaces/IEncodedChunk';

class Encoder {
  #encoder: VideoEncoder | null = null;

  #onChunkCallback: ((chunk: IEncodedChunk) => void) | null = null;
  #frameCounter: number = 0;

  onChunk = (callback: (chunk: IEncodedChunk) => void): void => {
    this.#onChunkCallback = callback;
  };

  init = async (): Promise<void> => {
    const init: VideoEncoderInit = {
      output: this.#handleChunk,
      error: (e: DOMException) => {
        // eslint-disable-next-line no-console
        console.log('Encoder error: ', e.message);
      }
    };

    const config: VideoEncoderConfig = {
      codec: 'vp8',
      width: 640,
      height: 480,
      bitrate: 2_000_000, // 2 Mbps
      framerate: 30
    };

    const {supported} = await VideoEncoder.isConfigSupported(config);
    if (supported) {
      this.#encoder = new VideoEncoder(init);
      this.#encoder.configure(config);
    } else {
      // eslint-disable-next-line no-console
      console.log('Configuration not supported', config);
    }
  };

  encode = (videoFrame: VideoFrame): void => {
    if (!this.#encoder) return;

    if (this.#encoder.encodeQueueSize > 2) {
      // Too many frames in flight, encoder is overwhelmed, let's drop this frame.
      // eslint-disable-next-line no-console
      console.log('Dropping frame t: ', videoFrame.timestamp);
      videoFrame.close();
    } else {
      // First frame (0) must be a keyframe, then every 150 frames
      const keyFrame: boolean = this.#frameCounter % 150 === 0;
      this.#encoder.encode(videoFrame, {keyFrame});
      videoFrame.close();
      this.#frameCounter++;
    }
  };

  // make sure that all pending encoding requests have been completed, you can call flush() and wait for its promise
  flush = async (): Promise<void> => {
    if (!this.#encoder) return;

    await this.#encoder.flush();
  };

  // Usually this function would be sending data chunks over the network or muxing them into a media container for storage.
  #handleChunk: EncodedVideoChunkOutputCallback = (
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata
  ) => {
    if (metadata && metadata.decoderConfig) {
      // Decoder needs to be configured (or reconfigured) with new parameters
      // when metadata has a new decoderConfig.
      // Usually it happens in the beginning or when the encoder has a new
      // codec specific binary configuration. (VideoDecoderConfig.description).
      // eslint-disable-next-line no-console
      console.log('Decoder config description: ', metadata.decoderConfig.description);
    }

    // actual bytes of encoded data
    const chunkData: Uint8Array = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkData);

    const encodedChunk: IEncodedChunk = {
      timestamp: chunk.timestamp,
      key: chunk.type === 'key',
      data: chunkData
    };

    // eslint-disable-next-line no-console
    console.log('Encoded chunk', encodedChunk);

    this.#onChunkCallback?.(encodedChunk);
  };
}

export default Encoder;
