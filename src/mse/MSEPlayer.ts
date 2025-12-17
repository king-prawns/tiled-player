import {AudioSourceId} from '@dash/DashDecoder';
import DashStreamManager from '@dash/DashStreamManager';
import Encoder from '@encoder/encoder';
import IEncodedChunk from '@interfaces/IEncodedChunk';
import {Muxer, StreamTarget} from 'webm-muxer';

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
  #disposed: boolean = false;

  // DASH stream management - MSE player is the orchestrator
  #stream1: DashStreamManager | null = null;
  #stream2: DashStreamManager | null = null;
  #encoder: Encoder | null = null;
  #abortController: AbortController | null = null;

  // Compositor state
  #swapped: boolean = false;
  #pipX: number = 0;
  #pipY: number = 0;
  #pipWidth: number = 0;
  #pipHeight: number = 0;

  // Compositor constants
  static readonly MIN_PIP_SIZE: number = 80;
  static readonly RESIZE_HANDLE_SIZE: number = 15;
  static readonly MAX_BUFFER_SEC: number = 30;

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
        onData: (data: Uint8Array, _position: number): void => {
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

  /**
   * Load and play two DASH streams with PiP compositor
   * MSE player orchestrates all fetching, decoding, compositing, and encoding
   */
  load = async (mpdUrl1: string, mpdUrl2: string): Promise<void> => {
    this.#abortController = new AbortController();
    const signal: AbortSignal = this.#abortController.signal;

    // Initialize PiP position
    this.#pipX = this.#width - this.#width / 3 - 10;
    this.#pipY = this.#height - this.#height / 3 - 10;
    this.#pipWidth = this.#width / 3;
    this.#pipHeight = this.#height / 3;

    // Create encoder
    this.#encoder = new Encoder();
    await this.#encoder.init();
    this.#encoder.onChunk((chunk: IEncodedChunk) => {
      this.appendVideoChunk(chunk);
    });

    // Create DASH stream managers
    this.#stream1 = new DashStreamManager({
      mpdUrl: mpdUrl1,
      sourceId: 'dash1',
      onAudioChunk: (chunk: IEncodedChunk, sourceId: AudioSourceId): void =>
        this.appendAudioChunk(chunk, sourceId),
      signal
    });

    this.#stream2 = new DashStreamManager({
      mpdUrl: mpdUrl2,
      sourceId: 'dash2',
      onAudioChunk: (chunk: IEncodedChunk, sourceId: AudioSourceId): void =>
        this.appendAudioChunk(chunk, sourceId),
      signal
    });

    // Initialize streams (fetch manifests)
    await Promise.all([this.#stream1.init(), this.#stream2.init()]);

    // Setup mouse event handlers for PiP interaction
    this.#setupPipInteraction();

    // Start the main loop
    await this.#runMainLoop();

    // Cleanup
    await this.#encoder?.flush();
  };

  dispose = (): void => {
    this.#disposed = true;

    // Abort any ongoing fetches
    this.#abortController?.abort();

    // Destroy DASH stream managers
    this.#stream1?.destroy();
    this.#stream2?.destroy();
    this.#stream1 = null;
    this.#stream2 = null;

    // Destroy encoder
    this.#encoder?.destroy();
    this.#encoder = null;

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

  /**
   * Get the video buffer ahead in seconds
   * Returns how many seconds of video are buffered ahead of current playback position
   */
  #getVideoBufferAhead = (): number => {
    if (!this.#videoElement || !this.#videoSourceBuffer) {
      return 0;
    }

    const currentTime: number = this.#videoElement.currentTime;
    const buffered: TimeRanges = this.#videoSourceBuffer.buffered;

    // Find the buffer range that contains currentTime
    for (let i: number = 0; i < buffered.length; i++) {
      const start: number = buffered.start(i);
      const end: number = buffered.end(i);

      if (currentTime >= start && currentTime <= end) {
        return end - currentTime;
      }
    }

    return 0;
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
   * Main loop - MSE player controls everything
   */
  #runMainLoop = async (): Promise<void> => {
    const signal: AbortSignal | undefined = this.#abortController?.signal;
    if (!this.#stream1 || !this.#stream2) return;

    // eslint-disable-next-line no-console
    console.log('[MSEPlayer] Fetching initial segments...');

    // Initial fetch - get enough frames to start
    await this.#fetchUntilFramesAvailable(5);

    // eslint-disable-next-line no-console
    console.log('[MSEPlayer] Starting compositor loop');

    // Create OffscreenCanvas for compositing
    const canvas: OffscreenCanvas = new OffscreenCanvas(this.#width, this.#height);
    const ctx: OffscreenCanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }

    const frameInterval: number = 1000 / 30;
    let lastFrameTime: number = 0;
    let frameCount: number = 0;

    while (!signal?.aborted && !this.#disposed) {
      const now: number = performance.now();
      if (now - lastFrameTime < frameInterval) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 5));
        continue;
      }
      lastFrameTime = now;

      // Check buffer and fetch more if needed
      this.#maintainBuffer();

      // Get frames from decoders
      const frame1: VideoFrame | undefined = this.#stream1.decoder.getFrame();
      const frame2: VideoFrame | undefined = this.#stream2.decoder.getFrame();

      if (!frame1 && !frame2) {
        const bothEnded: boolean = this.#stream1.isEnded && this.#stream2.isEnded;
        const noMoreFrames: boolean =
          this.#stream1.decoder.frames.length === 0 && this.#stream2.decoder.frames.length === 0;

        if (bothEnded && noMoreFrames) {
          // eslint-disable-next-line no-console
          console.log('[MSEPlayer] Both streams ended');
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 10));
        continue;
      }

      // Composite frames
      const bgFrame: VideoFrame | undefined = this.#swapped ? frame2 : frame1;
      const pipFrame: VideoFrame | undefined = this.#swapped ? frame1 : frame2;

      if (bgFrame) {
        ctx.drawImage(bgFrame, 0, 0, this.#width, this.#height);
        bgFrame.close();
      }

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.#pipX - 1, this.#pipY - 1, this.#pipWidth + 2, this.#pipHeight + 2);

      if (pipFrame) {
        ctx.drawImage(pipFrame, this.#pipX, this.#pipY, this.#pipWidth, this.#pipHeight);
        pipFrame.close();
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(
        this.#pipX + this.#pipWidth - MSEPlayer.RESIZE_HANDLE_SIZE,
        this.#pipY + this.#pipHeight - MSEPlayer.RESIZE_HANDLE_SIZE,
        MSEPlayer.RESIZE_HANDLE_SIZE,
        MSEPlayer.RESIZE_HANDLE_SIZE
      );

      // Encode and send to MSE
      const timestamp: number = frameCount * (1000000 / 30);
      const videoFrame: VideoFrame = new VideoFrame(canvas, {timestamp});
      this.#encoder?.encode(videoFrame);
      frameCount++;
    }
  };

  /**
   * Fetch segments until we have enough frames
   */
  #fetchUntilFramesAvailable = async (minFrames: number): Promise<void> => {
    if (!this.#stream1 || !this.#stream2) return;

    while (
      (this.#stream1.decoder.frames.length < minFrames || this.#stream2.decoder.frames.length < minFrames) &&
      !this.#disposed
    ) {
      // eslint-disable-next-line no-await-in-loop
      const hasMore1: boolean = await this.#stream1.fetchNextChunk();
      // eslint-disable-next-line no-await-in-loop
      const hasMore2: boolean = await this.#stream2.fetchNextChunk();

      if (!hasMore1 && !hasMore2) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 10));
    }
  };

  /**
   * Maintain buffer - fetch more when buffer drops below threshold
   */
  #maintainBuffer = (): void => {
    if (!this.#stream1 || !this.#stream2) return;

    const bufferAhead: number = this.#getVideoBufferAhead();

    // Fetch more if buffer is below threshold
    if (bufferAhead < MSEPlayer.MAX_BUFFER_SEC) {
      // Fetch a few chunks from each stream
      if (!this.#stream1.isEnded) {
        this.#stream1.fetchNextChunk();
      }
      if (!this.#stream2.isEnded) {
        this.#stream2.fetchNextChunk();
      }
    }
  };

  /**
   * Setup mouse event handlers for PiP drag, resize, and swap
   */
  #setupPipInteraction = (): void => {
    if (!this.#videoElement) return;

    let isDragging: boolean = false;
    let isResizing: boolean = false;
    let dragOffsetX: number = 0;
    let dragOffsetY: number = 0;

    const isInPipArea = (x: number, y: number): boolean => {
      return (
        x >= this.#pipX &&
        x <= this.#pipX + this.#pipWidth &&
        y >= this.#pipY &&
        y <= this.#pipY + this.#pipHeight
      );
    };

    const isInResizeHandle = (x: number, y: number): boolean => {
      return (
        x >= this.#pipX + this.#pipWidth - MSEPlayer.RESIZE_HANDLE_SIZE &&
        x <= this.#pipX + this.#pipWidth &&
        y >= this.#pipY + this.#pipHeight - MSEPlayer.RESIZE_HANDLE_SIZE &&
        y <= this.#pipY + this.#pipHeight
      );
    };

    const getScaledCoords = (e: MouseEvent): {x: number; y: number} => {
      const rect: DOMRect = (e.target as HTMLElement).getBoundingClientRect();
      const scaleX: number = this.#width / rect.width;
      const scaleY: number = this.#height / rect.height;

      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

    const handleMouseDown = (e: MouseEvent): void => {
      const {x, y} = getScaledCoords(e);
      if (isInResizeHandle(x, y)) {
        isResizing = true;
      } else if (isInPipArea(x, y)) {
        isDragging = true;
        dragOffsetX = x - this.#pipX;
        dragOffsetY = y - this.#pipY;
      }
    };

    const handleMouseMove = (e: MouseEvent): void => {
      const {x, y} = getScaledCoords(e);
      if (isDragging) {
        this.#pipX = Math.max(0, Math.min(this.#width - this.#pipWidth, x - dragOffsetX));
        this.#pipY = Math.max(0, Math.min(this.#height - this.#pipHeight, y - dragOffsetY));
      } else if (isResizing) {
        this.#pipWidth = Math.max(MSEPlayer.MIN_PIP_SIZE, Math.min(this.#width - this.#pipX, x - this.#pipX));
        this.#pipHeight = Math.max(
          MSEPlayer.MIN_PIP_SIZE,
          Math.min(this.#height - this.#pipY, y - this.#pipY)
        );
      }
    };

    const handleMouseUp = (): void => {
      isDragging = false;
      isResizing = false;
    };

    const handleDoubleClick = (): void => {
      this.#swapped = !this.#swapped;
      // Switch audio source
      this.setActiveAudioSource(this.#swapped ? 'dash2' : 'dash1');
      // eslint-disable-next-line no-console
      console.log(`[MSEPlayer] Swapped - audio now: ${this.#swapped ? 'dash2' : 'dash1'}`);
    };

    this.#videoElement.addEventListener('mousedown', handleMouseDown);
    this.#videoElement.addEventListener('mousemove', handleMouseMove);
    this.#videoElement.addEventListener('mouseup', handleMouseUp);
    this.#videoElement.addEventListener('mouseleave', handleMouseUp);
    this.#videoElement.addEventListener('dblclick', handleDoubleClick);
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
