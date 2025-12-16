import IEncodedChunk from '@interfaces/IEncodedChunk';
import {Muxer, StreamTarget} from 'webm-muxer';

export type AudioSourceId = 'dash1' | 'dash2';

/**
 * MSEPlayer - Plays encoded video/audio using Media Source Extensions
 * Uses separate SourceBuffers for video and audio to enable audio switching
 */
class MSEPlayer {
  #videoElementId: string;
  #mediaSource: MediaSource | null = null;
  #videoSourceBuffer: SourceBuffer | null = null;
  #audioSourceBuffer: SourceBuffer | null = null;
  #videoElement: HTMLVideoElement | null = null;

  // Separate muxers for video and audio
  #videoMuxer: Muxer<StreamTarget> | null = null;
  #audioMuxer: Muxer<StreamTarget> | null = null;
  #width: number;
  #height: number;
  #sampleRate: number;

  // Pending data queues for MSE (separate for video and audio)
  #videoPendingChunks: Uint8Array[] = [];
  #audioPendingChunks: Uint8Array[] = [];
  #isVideoAppending: boolean = false;
  #isAudioAppending: boolean = false;
  #initialized: boolean = false;

  // Audio source management
  #activeAudioSource: AudioSourceId = 'dash1';
  // Track the last audio timestamp we appended (for continuous playback)
  #lastAppendedAudioTimestamp: number = 0;
  // Audio chunk duration in microseconds (20ms for Opus)
  #audioChunkDurationUs: number = 20_000;
  // Buffer audio from BOTH sources (key insight from MSEPlayer2!)
  #audioBuffers: Map<AudioSourceId, Array<IEncodedChunk>> = new Map([
    ['dash1', []],
    ['dash2', []]
  ]);

  #videoChunkCount: number = 0;
  #audioChunkCount: number = 0;
  #disposed: boolean = false;

  constructor(videoElementId: string, width: number = 640, height: number = 480, sampleRate: number = 48000) {
    this.#videoElementId = videoElementId;
    this.#width = width;
    this.#height = height;
    this.#sampleRate = sampleRate;
  }

  init = async (): Promise<void> => {
    this.#videoElement = document.getElementById(this.#videoElementId) as HTMLVideoElement;
    if (!this.#videoElement) {
      throw new Error(`Video element not found: ${this.#videoElementId}`);
    }

    // Create MediaSource
    this.#mediaSource = new MediaSource();

    // Set video src to MediaSource object URL
    this.#videoElement.src = URL.createObjectURL(this.#mediaSource);

    // Wait for MediaSource to be ready
    await new Promise<void>((resolve: () => void, reject: (e: Error) => void) => {
      if (!this.#mediaSource) return reject(new Error('MediaSource is null'));

      this.#mediaSource.addEventListener(
        'sourceopen',
        () => {
          // eslint-disable-next-line no-console
          console.log('[MSEPlayer] MediaSource opened');
          resolve();
        },
        {once: true}
      );

      this.#mediaSource.addEventListener(
        'error',
        () => {
          reject(new Error('MediaSource error'));
        },
        {once: true}
      );
    });

    // Add separate SourceBuffers for video and audio
    const videoMimeType: string = 'video/webm; codecs="vp8"';
    const audioMimeType: string = 'audio/webm; codecs="opus"';

    if (!MediaSource.isTypeSupported(videoMimeType)) {
      throw new Error(`Video MIME type not supported: ${videoMimeType}`);
    }
    if (!MediaSource.isTypeSupported(audioMimeType)) {
      throw new Error(`Audio MIME type not supported: ${audioMimeType}`);
    }

    // Video SourceBuffer
    this.#videoSourceBuffer = this.#mediaSource.addSourceBuffer(videoMimeType);
    this.#videoSourceBuffer.mode = 'segments';
    this.#videoSourceBuffer.addEventListener('updateend', this.#onVideoUpdateEnd);
    this.#videoSourceBuffer.addEventListener('error', (e: Event) => {
      // eslint-disable-next-line no-console
      console.error('[MSEPlayer] Video SourceBuffer error:', e);
    });

    // Audio SourceBuffer
    this.#audioSourceBuffer = this.#mediaSource.addSourceBuffer(audioMimeType);
    this.#audioSourceBuffer.mode = 'segments';
    this.#audioSourceBuffer.addEventListener('updateend', this.#onAudioUpdateEnd);
    this.#audioSourceBuffer.addEventListener('error', (e: Event) => {
      // eslint-disable-next-line no-console
      console.error('[MSEPlayer] Audio SourceBuffer error:', e);
    });

    // Create video muxer (video only)
    this.#videoMuxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, _position: number) => {
          this.#videoPendingChunks.push(data);
          this.#tryAppendVideo();
        }
      }),
      video: {
        codec: 'V_VP8',
        width: this.#width,
        height: this.#height
      },
      firstTimestampBehavior: 'offset',
      streaming: true,
      type: 'webm'
    });

    // Create audio muxer (audio only)
    this.#createAudioMuxer();

    this.#initialized = true;
    // eslint-disable-next-line no-console
    console.log('[MSEPlayer] Initialized with video:', videoMimeType, 'audio:', audioMimeType);
  };

  /**
   * Create or recreate the audio muxer
   */
  #createAudioMuxer = (): void => {
    // Finalize existing muxer if any
    if (this.#audioMuxer) {
      try {
        this.#audioMuxer.finalize();
      } catch {
        // Ignore errors
      }
    }

    this.#audioMuxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, _position: number): void => {
          this.#audioPendingChunks.push(data);
          this.#tryAppendAudio();
        }
      }),
      audio: {
        codec: 'A_OPUS',
        sampleRate: this.#sampleRate,
        numberOfChannels: 2
      },
      firstTimestampBehavior: 'offset',
      streaming: true,
      type: 'webm'
    });
  };

  /**
   * Append an encoded video chunk
   */
  appendVideoChunk = (chunk: IEncodedChunk): void => {
    if (this.#disposed || !this.#initialized || !this.#videoMuxer) {
      return;
    }

    this.#videoChunkCount++;

    // Create a real EncodedVideoChunk from our data
    const encodedChunk: EncodedVideoChunk = new EncodedVideoChunk({
      type: chunk.key ? 'key' : 'delta',
      timestamp: chunk.timestamp,
      duration: 33333, // ~30fps
      data: chunk.data
    });

    // Add video chunk to muxer
    this.#videoMuxer.addVideoChunk(encodedChunk, undefined, chunk.timestamp);

    // Log every 30 frames
    if (this.#videoChunkCount % 30 === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[MSEPlayer] Video chunk #${this.#videoChunkCount}, ts: ${chunk.timestamp}, pending: ${this.#videoPendingChunks.length}`
      );
    }
  };

  /**
   * Append an encoded audio chunk - buffers ALL sources, only appends active
   */
  appendAudioChunk = (chunk: IEncodedChunk, sourceId: AudioSourceId): void => {
    if (this.#disposed || !this.#initialized || !this.#audioMuxer) {
      return;
    }

    // ALWAYS store chunk in the source's buffer (even if not active)
    const buffer: Array<IEncodedChunk> | undefined = this.#audioBuffers.get(sourceId);
    if (buffer) {
      buffer.push(chunk);
      // Keep only last 60 seconds of audio (3000 chunks at 20ms each)
      while (buffer.length > 3000) {
        buffer.shift();
      }
    }

    // Only append to muxer if this is the active audio source
    if (sourceId !== this.#activeAudioSource) {
      return;
    }

    this.#audioChunkCount++;

    // Use CONTINUOUS timestamps - always increment from last appended
    const adjustedTimestamp: number = this.#lastAppendedAudioTimestamp;
    this.#lastAppendedAudioTimestamp += this.#audioChunkDurationUs;

    // Create a real EncodedAudioChunk from our data
    const encodedChunk: EncodedAudioChunk = new EncodedAudioChunk({
      type: 'key', // Audio chunks are always key frames
      timestamp: adjustedTimestamp,
      duration: this.#audioChunkDurationUs,
      data: chunk.data
    });

    // Add audio chunk to muxer
    this.#audioMuxer.addAudioChunk(encodedChunk, undefined, adjustedTimestamp);
  };

  /**
   * Set the active audio source (called when tiles are swapped)
   * Clears audio buffer and feeds new source from current position
   */
  setActiveAudioSource = (sourceId: AudioSourceId): void => {
    if (this.#activeAudioSource === sourceId) {
      return;
    }

    const oldSource: AudioSourceId = this.#activeAudioSource;
    const newBuffer: Array<IEncodedChunk> | undefined = this.#audioBuffers.get(sourceId);
    const oldBuffer: Array<IEncodedChunk> | undefined = this.#audioBuffers.get(oldSource);

    // Get ACTUAL playback position (not buffered position)
    const currentTime: number = this.#videoElement?.currentTime ?? 0;
    const currentTimeUs: number = currentTime * 1_000_000;

    // eslint-disable-next-line no-console
    console.log(
      `[MSEPlayer] Switching audio: ${oldSource} → ${sourceId}, ` +
        `currentTime=${currentTime.toFixed(2)}s, ` +
        `newBuffer=${newBuffer?.length || 0}, oldBuffer=${oldBuffer?.length || 0}`
    );

    this.#activeAudioSource = sourceId;

    // Clear the audio buffer from currentTime onwards so new audio plays immediately
    if (this.#audioSourceBuffer && !this.#audioSourceBuffer.updating) {
      try {
        const buffered: TimeRanges = this.#audioSourceBuffer.buffered;
        if (buffered.length > 0) {
          const bufferEnd: number = buffered.end(buffered.length - 1);
          const clearFrom: number = currentTime + 0.1; // Start clearing 100ms ahead
          if (bufferEnd > clearFrom) {
            // eslint-disable-next-line no-console
            console.log(
              `[MSEPlayer] Clearing audio buffer from ${clearFrom.toFixed(2)}s to ${bufferEnd.toFixed(2)}s`
            );
            this.#audioSourceBuffer.remove(clearFrom, bufferEnd);
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[MSEPlayer] Failed to clear audio buffer:', e);
      }
    }

    // RECREATE the audio muxer so it accepts timestamps from current position
    // The old muxer won't accept timestamps that go backwards
    this.#createAudioMuxer();

    // RESET the audio timestamp to current playback position
    this.#lastAppendedAudioTimestamp = currentTimeUs + 100_000; // Start 100ms ahead

    // eslint-disable-next-line no-console
    console.log(
      `[MSEPlayer] Audio muxer recreated, timestamp reset to ${this.#lastAppendedAudioTimestamp}µs`
    );

    // Feed buffered audio from the new source
    if (newBuffer && newBuffer.length > 0 && this.#audioMuxer) {
      // Calculate which chunk index corresponds to the CURRENT PLAYBACK position
      const playbackChunkIndex: number = Math.floor(currentTimeUs / this.#audioChunkDurationUs);

      // Find chunks in the new buffer starting from current playback position
      const startIndex: number = Math.max(0, Math.min(playbackChunkIndex, newBuffer.length - 1));
      const chunksToFeed: Array<IEncodedChunk> = newBuffer.slice(startIndex);

      // eslint-disable-next-line no-console
      console.log(`[MSEPlayer] Feeding ${chunksToFeed.length} buffered chunks from index ${startIndex}`);

      // Feed the buffered chunks with continuous timestamps FROM CURRENT POSITION
      for (const chunk of chunksToFeed) {
        const adjustedTimestamp: number = this.#lastAppendedAudioTimestamp;
        this.#lastAppendedAudioTimestamp += this.#audioChunkDurationUs;

        const encodedChunk: EncodedAudioChunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: adjustedTimestamp,
          duration: this.#audioChunkDurationUs,
          data: chunk.data
        });

        this.#audioMuxer.addAudioChunk(encodedChunk, undefined, adjustedTimestamp);
      }

      // Clear the new buffer since we've consumed it
      newBuffer.length = 0;
    }
  };

  /**
   * Get the current active audio source
   */
  getActiveAudioSource = (): AudioSourceId => {
    return this.#activeAudioSource;
  };

  dispose = (): void => {
    this.#disposed = true;

    // Finalize muxers
    if (this.#videoMuxer) {
      try {
        this.#videoMuxer.finalize();
      } catch {
        // Ignore errors during finalize
      }
      this.#videoMuxer = null;
    }
    if (this.#audioMuxer) {
      try {
        this.#audioMuxer.finalize();
      } catch {
        // Ignore errors during finalize
      }
      this.#audioMuxer = null;
    }

    if (this.#videoSourceBuffer) {
      this.#videoSourceBuffer.removeEventListener('updateend', this.#onVideoUpdateEnd);
    }
    if (this.#audioSourceBuffer) {
      this.#audioSourceBuffer.removeEventListener('updateend', this.#onAudioUpdateEnd);
    }
    if (this.#mediaSource && this.#mediaSource.readyState === 'open') {
      try {
        this.#mediaSource.endOfStream();
      } catch {
        // Ignore
      }
    }
    if (this.#videoElement) {
      URL.revokeObjectURL(this.#videoElement.src);
      this.#videoElement.src = '';
    }
    this.#videoPendingChunks = [];
    this.#audioPendingChunks = [];
  };

  #tryAppendVideo = (): void => {
    if (
      this.#disposed ||
      this.#isVideoAppending ||
      this.#videoPendingChunks.length === 0 ||
      !this.#videoSourceBuffer
    ) {
      return;
    }

    if (this.#videoSourceBuffer.updating) {
      return;
    }

    this.#isVideoAppending = true;
    const data: Uint8Array | undefined = this.#videoPendingChunks.shift();
    if (data) {
      try {
        this.#videoSourceBuffer.appendBuffer(data as BufferSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[MSEPlayer] Video appendBuffer error:', e);
        this.#isVideoAppending = false;
      }
    }
  };

  #tryAppendAudio = (): void => {
    if (
      this.#disposed ||
      this.#isAudioAppending ||
      this.#audioPendingChunks.length === 0 ||
      !this.#audioSourceBuffer
    ) {
      return;
    }

    if (this.#audioSourceBuffer.updating) {
      return;
    }

    this.#isAudioAppending = true;
    const data: Uint8Array | undefined = this.#audioPendingChunks.shift();
    if (data) {
      try {
        this.#audioSourceBuffer.appendBuffer(data as BufferSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[MSEPlayer] Audio appendBuffer error:', e);
        this.#isAudioAppending = false;
      }
    }
  };

  #onVideoUpdateEnd = (): void => {
    this.#isVideoAppending = false;

    // Try to play when we have enough buffered video data
    if (this.#videoElement && this.#videoSourceBuffer) {
      const buffered: TimeRanges = this.#videoSourceBuffer.buffered;

      if (this.#videoElement.paused && buffered.length > 0 && buffered.end(0) > 0.5) {
        // eslint-disable-next-line no-console
        console.log(
          `[MSEPlayer] Attempting to play - video buffered: ${buffered.end(0).toFixed(2)}s, readyState: ${this.#videoElement.readyState}`
        );
        this.#videoElement.play().catch((e: Error) => {
          // eslint-disable-next-line no-console
          console.warn('[MSEPlayer] Autoplay blocked:', e.message);
        });
      }
    }

    // Process next video chunk
    this.#tryAppendVideo();
  };

  #onAudioUpdateEnd = (): void => {
    this.#isAudioAppending = false;

    // Process next audio chunk
    this.#tryAppendAudio();
  };
}

export default MSEPlayer;
