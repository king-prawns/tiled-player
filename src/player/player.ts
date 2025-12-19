import Dispatcher from '@dispatcher/dispatcher';
import Encoder from '@encoder/encoder';
import EEvent from '@enum/EEvent';
import IEncodedChunk from '@interfaces/IEncodedChunk';
import StreamManager from '@stream/streamManager';
import {Muxer, StreamTarget} from 'webm-muxer';

export type AudioSourceId = 'source1' | 'source2';

class Player {
  #videoElementId: string;
  #mediaSource: MediaSource | null = null;
  #videoSourceBuffer: SourceBuffer | null = null;
  #audioSourceBuffer: SourceBuffer | null = null;
  #videoElement: HTMLVideoElement | null = null;
  #dispatcher: Dispatcher;

  #videoMuxer: Muxer<StreamTarget> | null = null;
  #audioMuxer: Muxer<StreamTarget> | null = null;
  #width: number;
  #height: number;
  #sampleRate: number;

  // Pending data queues for MSE (separate for video and audio)
  #videoPendingChunks: Uint8Array[] = [];
  #audioPendingChunks: Uint8Array[] = [];

  // Audio source management
  #activeAudioSource: AudioSourceId = 'source1';
  #lastAppendedAudioTimestamp: number = 0;
  // Audio chunk duration in microseconds (20ms for Opus)
  #audioChunkDurationUs: number = 20_000;

  #cachedAudioData: Map<AudioSourceId, Array<AudioData>> = new Map([
    ['source1', []],
    ['source2', []]
  ]);

  #disposed: boolean = false;

  #stream1: StreamManager | null = null;
  #stream2: StreamManager | null = null;
  #videoEncoder: Encoder | null = null;
  #audioEncoder: Encoder | null = null;
  #abortController: AbortController | null = null;

  // Compositor state
  #swapped: boolean = false;
  #pipX: number = 0;
  #pipY: number = 0;
  #pipWidth: number = 0;
  #pipHeight: number = 0;
  #compositorCanvas: OffscreenCanvas | null = null;
  #compositorCtx: OffscreenCanvasRenderingContext2D | null = null;
  #frameCount: number = 0;
  #lastFrameTime: number = 0;
  #animationFrameId: number = 0;

  // Compositor constants
  static readonly MIN_PIP_SIZE: number = 80;
  static readonly RESIZE_HANDLE_SIZE: number = 15;
  static readonly MAX_BUFFER_AHEAD: number = 30;
  static readonly MAX_BUFFER_BEHIND: number = 10;

  constructor(
    videoElementId: string,
    width: number,
    height: number,
    sampleRate: number,
    dispatcher: Dispatcher
  ) {
    this.#videoElementId = videoElementId;
    this.#width = width;
    this.#height = height;
    this.#sampleRate = sampleRate;
    this.#dispatcher = dispatcher;
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
          console.log('[Player] MediaSource opened');
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

    this.#videoSourceBuffer = this.#mediaSource.addSourceBuffer(videoMimeType);
    this.#videoSourceBuffer.mode = 'segments';
    this.#videoSourceBuffer.addEventListener('updateend', this.#onVideoUpdateEnd);
    this.#videoSourceBuffer.addEventListener('error', (e: Event) => {
      // eslint-disable-next-line no-console
      console.error('[Player] Video SourceBuffer error:', e);
    });

    this.#audioSourceBuffer = this.#mediaSource.addSourceBuffer(audioMimeType);
    this.#audioSourceBuffer.mode = 'segments';
    this.#audioSourceBuffer.addEventListener('updateend', this.#onAudioUpdateEnd);
    this.#audioSourceBuffer.addEventListener('error', (e: Event) => {
      // eslint-disable-next-line no-console
      console.error('[Player] Audio SourceBuffer error:', e);
    });

    this.#createVideoMuxer();
    this.#createAudioMuxer();

    this.#videoElement.addEventListener('timeupdate', this.#onTimeUpdate);

    // eslint-disable-next-line no-console
    console.log('[Player] Initialized with video:', videoMimeType, 'audio:', audioMimeType);
  };

  /**
   * Load and play two DASH streams with PiP compositor
   */
  load = async (mpdUrl1: string, mpdUrl2: string): Promise<void> => {
    this.#abortController = new AbortController();
    const signal: AbortSignal = this.#abortController.signal;

    // Create video encoder (for composited frames)
    this.#videoEncoder = new Encoder('video');
    await this.#videoEncoder.init({width: this.#width, height: this.#height});
    this.#videoEncoder.onChunk((chunk: IEncodedChunk) => {
      this.#appendVideoChunk(chunk);
    });

    // Create audio encoder (re-encode decoded AudioData to Opus)
    this.#audioEncoder = new Encoder('audio');
    await this.#audioEncoder.init({sampleRate: this.#sampleRate});
    this.#audioEncoder.onChunk((chunk: IEncodedChunk) => {
      this.#appendAudioChunk(chunk);
    });

    // Create stream managers
    this.#stream1 = new StreamManager({
      mpdUrl: mpdUrl1,
      signal
    });

    this.#stream2 = new StreamManager({
      mpdUrl: mpdUrl2,
      signal
    });

    // Start manifest/segment fetching
    this.#stream1.start();
    this.#stream2.start();

    // Setup mouse event handlers for PiP interaction
    this.#setupPip();

    // Start the main loop
    this.#runCompositorLoop();
  };

  dispose = (): void => {
    this.#disposed = true;

    // Cancel animation frame
    if (this.#animationFrameId) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = 0;
    }

    // Abort any ongoing fetches
    this.#abortController?.abort();

    // Destroy DASH stream managers
    this.#stream1?.destroy();
    this.#stream2?.destroy();
    this.#stream1 = null;
    this.#stream2 = null;

    // Destroy encoders
    this.#videoEncoder?.destroy();
    this.#videoEncoder = null;
    this.#audioEncoder?.destroy();
    this.#audioEncoder = null;

    // Close cached AudioData
    for (const buffer of this.#cachedAudioData.values()) {
      buffer.forEach((a: AudioData) => a.close());
      buffer.length = 0;
    }

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
      this.#videoElement.removeEventListener('timeupdate', this.#onTimeUpdate);
      URL.revokeObjectURL(this.#videoElement.src);
      this.#videoElement.src = '';
    }
    this.#videoPendingChunks = [];
    this.#audioPendingChunks = [];
  };

  #appendVideoChunk = (chunk: IEncodedChunk): void => {
    if (this.#disposed || !this.#videoMuxer) {
      return;
    }

    // Create a real EncodedVideoChunk from our data
    const encodedChunk: EncodedVideoChunk = new EncodedVideoChunk({
      type: chunk.key ? 'key' : 'delta',
      timestamp: chunk.timestamp,
      duration: 33333, // ~30fps
      data: chunk.data
    });

    // Add video chunk to muxer
    this.#videoMuxer.addVideoChunk(encodedChunk, undefined, chunk.timestamp);
  };

  #appendAudioChunk = (chunk: IEncodedChunk): void => {
    if (this.#disposed || !this.#audioMuxer) {
      return;
    }

    // Use CONTINUOUS timestamps - always increment from last appended
    const adjustedTimestamp: number = this.#lastAppendedAudioTimestamp;
    this.#lastAppendedAudioTimestamp += this.#audioChunkDurationUs;

    // Create EncodedAudioChunk from IEncodedChunk data
    const encodedChunk: EncodedAudioChunk = new EncodedAudioChunk({
      type: chunk.key ? 'key' : 'delta',
      timestamp: adjustedTimestamp,
      duration: this.#audioChunkDurationUs,
      data: chunk.data
    });

    // Add audio chunk to muxer with adjusted timestamp
    this.#audioMuxer.addAudioChunk(encodedChunk, undefined, adjustedTimestamp);
  };

  #createVideoMuxer = (): void => {
    if (this.#videoMuxer) {
      try {
        this.#videoMuxer.finalize();
      } catch {
        // Ignore errors
      }
    }

    this.#videoMuxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, _position: number): void => {
          this.#videoPendingChunks.push(data);
          this.#appendVideo();
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
  };

  #createAudioMuxer = (): void => {
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
          this.#appendAudio();
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
   * Set the active audio source (called when tiles are swapped)
   * Clears audio buffer and feeds new source from current position
   */
  #setActiveAudioSource = (sourceId: AudioSourceId): void => {
    if (this.#activeAudioSource === sourceId) {
      return;
    }

    const oldSource: AudioSourceId = this.#activeAudioSource;
    const newBuffer: Array<AudioData> | undefined = this.#cachedAudioData.get(sourceId);
    const oldBuffer: Array<AudioData> | undefined = this.#cachedAudioData.get(oldSource);

    // Get ACTUAL playback position (not buffered position)
    const currentTime: number = this.#videoElement?.currentTime ?? 0;
    const currentTimeUs: number = currentTime * 1_000_000;

    // eslint-disable-next-line no-console
    console.log(
      `[Player] Switching audio: ${oldSource} → ${sourceId}, ` +
        `currentTime=${currentTime.toFixed(2)}s, ` +
        `newBuffer=${newBuffer?.length || 0}, oldBuffer=${oldBuffer?.length || 0}`
    );

    this.#activeAudioSource = sourceId;

    this.#dispatcher.emit(EEvent.changeSource, {source: sourceId});

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
              `[Player] Clearing audio buffer from ${clearFrom.toFixed(2)}s to ${bufferEnd.toFixed(2)}s`
            );
            this.#audioSourceBuffer.remove(clearFrom, bufferEnd);
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Player] Failed to clear audio buffer:', e);
      }
    }

    // RECREATE the audio muxer so it accepts timestamps from current position
    // The old muxer won't accept timestamps that go backwards
    this.#createAudioMuxer();

    // RESET the audio timestamp to current playback position
    this.#lastAppendedAudioTimestamp = currentTimeUs + 100_000; // Start 100ms ahead

    // eslint-disable-next-line no-console
    console.log(`[Player] Audio muxer recreated, timestamp reset to ${this.#lastAppendedAudioTimestamp}µs`);

    // Feed buffered AudioData from the new source (re-encode them)
    if (newBuffer && newBuffer.length > 0 && this.#audioEncoder) {
      // Calculate which frame index corresponds to the CURRENT PLAYBACK position
      const playbackFrameIndex: number = Math.floor(currentTimeUs / this.#audioChunkDurationUs);

      // Find frames in the new buffer starting from current playback position
      const startIndex: number = Math.max(0, Math.min(playbackFrameIndex, newBuffer.length - 1));
      const framesToFeed: Array<AudioData> = newBuffer.slice(startIndex);

      // eslint-disable-next-line no-console
      console.log(`[Player] Feeding ${framesToFeed.length} buffered AudioData from index ${startIndex}`);

      // Re-encode the buffered AudioData
      for (const audioData of framesToFeed) {
        this.#audioEncoder.encode(audioData);
      }

      // Close and clear the consumed frames from buffer
      for (const audioData of newBuffer) {
        audioData.close();
      }
      newBuffer.length = 0;
    }
  };

  #runCompositorLoop = (): void => {
    if (!this.#stream1 || !this.#stream2) return;

    // eslint-disable-next-line no-console
    console.log('[Player] Starting compositor loop with requestAnimationFrame');

    // Create OffscreenCanvas for compositing
    this.#compositorCanvas = new OffscreenCanvas(this.#width, this.#height);
    this.#compositorCtx = this.#compositorCanvas.getContext('2d');
    if (!this.#compositorCtx) {
      throw new Error('Failed to get 2D context');
    }

    this.#frameCount = 0;
    this.#lastFrameTime = 0;

    // Start the animation loop
    this.#animationFrameId = requestAnimationFrame(this.#compositorTick);
  };

  /**
   * Single tick of the compositor loop
   */
  #compositorTick = (timestamp: number): void => {
    const signal: AbortSignal | undefined = this.#abortController?.signal;
    if (signal?.aborted || this.#disposed || !this.#stream1 || !this.#stream2) {
      return;
    }

    const frameInterval: number = 1000 / 30;
    if (timestamp - this.#lastFrameTime < frameInterval) {
      this.#animationFrameId = requestAnimationFrame(this.#compositorTick);

      return;
    }
    this.#lastFrameTime = timestamp;

    // Pull decoded audio data from both decoders and encode them
    this.#pullAudioData();

    // Get frames from decoders
    const frame1: VideoFrame | undefined = this.#stream1.decoder.getVideoFrame();
    const frame2: VideoFrame | undefined = this.#stream2.decoder.getVideoFrame();

    if (!frame1 && !frame2) {
      const bothEnded: boolean = this.#stream1.isEnded && this.#stream2.isEnded;
      const noMoreFrames: boolean =
        this.#stream1.decoder.videoFrames.length === 0 && this.#stream2.decoder.videoFrames.length === 0;

      if (bothEnded && noMoreFrames) {
        // eslint-disable-next-line no-console
        console.log('[Player] Both streams ended');

        return;
      }
      // No frames yet, continue waiting
      this.#animationFrameId = requestAnimationFrame(this.#compositorTick);

      return;
    }

    // Composite frames
    this.#compositeFrame(frame1, frame2);

    // Schedule next frame
    this.#animationFrameId = requestAnimationFrame(this.#compositorTick);
  };

  /**
   * Composite video frames and encode to MSE
   */
  #compositeFrame = (frame1: VideoFrame | undefined, frame2: VideoFrame | undefined): void => {
    if (!this.#compositorCtx || !this.#compositorCanvas) return;

    const ctx: OffscreenCanvasRenderingContext2D = this.#compositorCtx;
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
      this.#pipX + this.#pipWidth - Player.RESIZE_HANDLE_SIZE,
      this.#pipY + this.#pipHeight - Player.RESIZE_HANDLE_SIZE,
      Player.RESIZE_HANDLE_SIZE,
      Player.RESIZE_HANDLE_SIZE
    );

    // Encode and send to MSE
    const frameTimestamp: number = this.#frameCount * (1000000 / 30);
    const videoFrame: VideoFrame = new VideoFrame(this.#compositorCanvas, {timestamp: frameTimestamp});
    this.#videoEncoder?.encode(videoFrame);
    this.#frameCount++;
  };

  /**
   * Pull decoded audio data from decoder buffers and encode them
   * This is called every frame to collect new audio data
   */
  #pullAudioData = (): void => {
    if (!this.#stream1 || !this.#stream2 || !this.#audioEncoder) return;

    // Pull all available audio data from stream1 (source1)
    const audioData1: Array<AudioData> = this.#stream1.decoder.drainAudioData();
    for (const audioData of audioData1) {
      this.#processAudioData(audioData, 'source1');
    }

    // Pull all available audio data from stream2 (source2)
    const audioData2: Array<AudioData> = this.#stream2.decoder.drainAudioData();
    for (const audioData of audioData2) {
      this.#processAudioData(audioData, 'source2');
    }
  };

  /**
   * Process decoded AudioData: buffer it and encode if from active source
   */
  #processAudioData = (audioData: AudioData, sourceId: AudioSourceId): void => {
    if (this.#disposed) {
      audioData.close();

      return;
    }

    const buffer: Array<AudioData> | undefined = this.#cachedAudioData.get(sourceId);
    if (buffer) {
      // Clone the AudioData since we need to keep it in buffer
      buffer.push(audioData.clone());
      // Keep only last 60 seconds of audio (3000 frames at 20ms each)
      while (buffer.length > 3000) {
        const old: AudioData | undefined = buffer.shift();
        old?.close();
      }
    }

    // Only encode if this is the active audio source
    if (sourceId !== this.#activeAudioSource) {
      audioData.close();

      return;
    }

    // Encode the AudioData - the encoder callback will handle muxing
    this.#audioEncoder?.encode(audioData);
    audioData.close();
  };

  /**
   * Setup mouse event handlers for PiP drag, resize, and swap
   */
  #setupPip = (): void => {
    if (!this.#videoElement) return;

    // Initialize PiP position
    this.#pipX = this.#width - this.#width / 3 - 10;
    this.#pipY = this.#height - this.#height / 3 - 10;
    this.#pipWidth = this.#width / 3;
    this.#pipHeight = this.#height / 3;

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
        x >= this.#pipX + this.#pipWidth - Player.RESIZE_HANDLE_SIZE &&
        x <= this.#pipX + this.#pipWidth &&
        y >= this.#pipY + this.#pipHeight - Player.RESIZE_HANDLE_SIZE &&
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
        this.#pipWidth = Math.max(Player.MIN_PIP_SIZE, Math.min(this.#width - this.#pipX, x - this.#pipX));
        this.#pipHeight = Math.max(Player.MIN_PIP_SIZE, Math.min(this.#height - this.#pipY, y - this.#pipY));
      }
    };

    const handleMouseUp = (): void => {
      isDragging = false;
      isResizing = false;
    };

    const handleDoubleClick = (): void => {
      this.#swapped = !this.#swapped;
      // Switch audio source
      this.#setActiveAudioSource(this.#swapped ? 'source2' : 'source1');
      // eslint-disable-next-line no-console
      console.log(`[Player] Swapped - audio now: ${this.#swapped ? 'source2' : 'source1'}`);
    };

    this.#videoElement.addEventListener('mousedown', handleMouseDown);
    this.#videoElement.addEventListener('mousemove', handleMouseMove);
    this.#videoElement.addEventListener('mouseup', handleMouseUp);
    this.#videoElement.addEventListener('mouseleave', handleMouseUp);
    this.#videoElement.addEventListener('dblclick', handleDoubleClick);
  };

  #appendVideo = (): void => {
    if (this.#disposed || this.#videoPendingChunks.length === 0 || !this.#videoSourceBuffer) {
      return;
    }

    if (this.#videoSourceBuffer.updating) {
      return;
    }

    const data: Uint8Array | undefined = this.#videoPendingChunks.shift();
    if (data) {
      try {
        this.#videoSourceBuffer.appendBuffer(data as BufferSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[Player] Video appendBuffer error:', e);
      }
    }
  };

  #appendAudio = (): void => {
    if (this.#disposed || this.#audioPendingChunks.length === 0 || !this.#audioSourceBuffer) {
      return;
    }

    if (this.#audioSourceBuffer.updating) {
      return;
    }

    const data: Uint8Array | undefined = this.#audioPendingChunks.shift();
    if (data) {
      try {
        this.#audioSourceBuffer.appendBuffer(data as BufferSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[Player] Audio appendBuffer error:', e);
      }
    }
  };

  #onVideoUpdateEnd = (): void => {
    // Try to play when we have enough buffered video data
    if (this.#videoElement && this.#videoSourceBuffer) {
      const buffered: TimeRanges = this.#videoSourceBuffer.buffered;

      if (this.#videoElement.paused && buffered.length > 0 && buffered.end(0) > 0.5) {
        // eslint-disable-next-line no-console
        console.log(
          `[Player] Attempting to play - video buffered: ${buffered.end(0).toFixed(2)}s, readyState: ${this.#videoElement.readyState}`
        );
        this.#videoElement.play().catch((e: Error) => {
          // eslint-disable-next-line no-console
          console.warn('[Player] Autoplay blocked:', e.message);
        });
      }
    }

    this.#emitBufferUpdate();
    this.#trimVideoBuffer();

    this.#appendVideo();
  };

  #onAudioUpdateEnd = (): void => {
    this.#emitBufferUpdate();
    this.#trimAudioBuffer();

    this.#appendAudio();
  };

  #onTimeUpdate = (): void => {
    if (!this.#videoElement) return;
    this.#dispatcher.emit(EEvent.timeUpdate, {
      currentTime: this.#videoElement.currentTime
    });
  };

  #emitBufferUpdate = (): void => {
    const videoRanges: Array<number> = [];
    const audioRanges: Array<number> = [];

    if (this.#videoSourceBuffer) {
      const buffered: TimeRanges = this.#videoSourceBuffer.buffered;
      for (let i: number = 0; i < buffered.length; i++) {
        videoRanges.push(buffered.start(i), buffered.end(i));
      }
    }

    if (this.#audioSourceBuffer) {
      const buffered: TimeRanges = this.#audioSourceBuffer.buffered;
      for (let i: number = 0; i < buffered.length; i++) {
        audioRanges.push(buffered.start(i), buffered.end(i));
      }
    }

    this.#dispatcher.emit(EEvent.bufferUpdate, {
      video: videoRanges,
      audio: audioRanges
    });
  };

  /**
   * Remove video data that is more than MAX_BUFFER_BEHIND seconds behind current playback
   */
  #trimVideoBuffer = (): void => {
    if (!this.#videoElement || !this.#videoSourceBuffer || this.#videoSourceBuffer.updating) {
      return;
    }

    const currentTime: number = this.#videoElement.currentTime;
    const removeEnd: number = currentTime - Player.MAX_BUFFER_BEHIND;

    if (removeEnd <= 0) {
      return;
    }

    const buffered: TimeRanges = this.#videoSourceBuffer.buffered;
    if (buffered.length > 0 && buffered.start(0) < removeEnd) {
      try {
        this.#videoSourceBuffer.remove(0, removeEnd);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Player] Failed to trim video buffer:', e);
      }
    }
  };

  /**
   * Remove audio data that is more than MAX_BUFFER_BEHIND seconds behind current playback
   */
  #trimAudioBuffer = (): void => {
    if (!this.#videoElement || !this.#audioSourceBuffer || this.#audioSourceBuffer.updating) {
      return;
    }

    const currentTime: number = this.#videoElement.currentTime;
    const removeEnd: number = currentTime - Player.MAX_BUFFER_BEHIND;

    if (removeEnd <= 0) {
      return;
    }

    const buffered: TimeRanges = this.#audioSourceBuffer.buffered;
    if (buffered.length > 0 && buffered.start(0) < removeEnd) {
      try {
        this.#audioSourceBuffer.remove(0, removeEnd);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Player] Failed to trim audio buffer:', e);
      }
    }
  };
}

export default Player;
