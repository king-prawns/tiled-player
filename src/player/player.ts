import Dispatcher from '@dispatcher/dispatcher';
import Encoder from '@encoder/encoder';
import EEvent from '@enum/EEvent';
import IEncodedChunk from '@interfaces/IEncodedChunk';
import {SegmentReady} from '@stream/streamDownloader';
import StreamManager from '@stream/streamManager';
import {Muxer, StreamTarget} from 'webm-muxer';

export type SourceId = 'source1' | 'source2';

class Player {
  #videoElementId: string;
  #mediaSource: MediaSource | null = null;
  #videoSourceBuffer: SourceBuffer | null = null;
  #audioSourceBuffer: SourceBuffer | null = null;
  #videoElement: HTMLVideoElement | null = null;
  #dispatcher: Dispatcher;

  #videoMuxer: Muxer<StreamTarget> | null = null;
  #width: number;
  #height: number;

  // Pending data queues for Video Chunks
  #videoPendingChunks: Uint8Array[] = [];

  #activeSource: SourceId = 'source1';

  // Audio management
  #cachedAudioSegments: Map<SourceId, Array<SegmentReady>> = new Map([
    ['source1', []],
    ['source2', []]
  ]);
  #audioSegmentIndex: number = 1;
  #audioInitAppended: boolean = false;

  #disposed: boolean = false;

  #stream1: StreamManager | null = null;
  #stream2: StreamManager | null = null;
  #videoEncoder: Encoder | null = null;
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

  constructor(videoElementId: string, width: number, height: number, dispatcher: Dispatcher) {
    this.#videoElementId = videoElementId;
    this.#width = width;
    this.#height = height;
    this.#dispatcher = dispatcher;
  }

  init = async (): Promise<void> => {
    this.#videoElement = document.getElementById(this.#videoElementId) as HTMLVideoElement;
    this.#videoElement.autoplay = true;
    if (!this.#videoElement) {
      throw new Error(`Video element not found: ${this.#videoElementId}`);
    }

    this.#mediaSource = new MediaSource();

    this.#videoElement.src = URL.createObjectURL(this.#mediaSource);

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
    const audioMimeType: string = 'audio/mp4; codecs="mp4a.40.2"';

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
    this.#videoEncoder = new Encoder();
    await this.#videoEncoder.init({width: this.#width, height: this.#height});
    this.#videoEncoder.onChunk((chunk: IEncodedChunk) => {
      this.#muxVideoChunk(chunk);
    });

    // Create stream managers
    this.#stream1 = new StreamManager({
      mpdUrl: mpdUrl1,
      sourceId: 'source1',
      signal,
      onAudioSegmentReady: this.#onAudioSegmentReady
    });

    this.#stream2 = new StreamManager({
      mpdUrl: mpdUrl2,
      sourceId: 'source2',
      signal,
      onAudioSegmentReady: this.#onAudioSegmentReady
    });

    // Start manifest/segment fetching
    this.#stream1.start();
    this.#stream2.start();

    // Setup mouse event handlers for PiP interaction
    this.#setupPip();

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

    // Clear cached AudioSegments
    this.#cachedAudioSegments.clear();

    // Finalize muxers
    if (this.#videoMuxer) {
      try {
        this.#videoMuxer.finalize();
      } catch {
        // Ignore errors during finalize
      }
      this.#videoMuxer = null;
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
  };

  #muxVideoChunk = (chunk: IEncodedChunk): void => {
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

  /**
   * Set the active audio source (called when tiles are swapped)
   * Clears audio buffer and feeds new source from current position
   */
  #setActiveAudioSource = (sourceId: SourceId): void => {
    if (this.#activeSource === sourceId) {
      return;
    }

    this.#activeSource = sourceId;
    this.#dispatcher.emit(EEvent.changeSource, {source: sourceId});

    // Clear audio buffer and reset position
    this.#clearAudioBufferAndReposition();
  };

  /**
   * Clear audio buffer and reposition to current time
   * If buffer is updating, wait for updateend before clearing
   */
  #clearAudioBufferAndReposition = (): void => {
    if (!this.#audioSourceBuffer || !this.#videoElement) {
      return;
    }

    if (this.#audioSourceBuffer.updating) {
      // Wait for current operation to complete, then clear
      const onUpdateEnd = (): void => {
        this.#audioSourceBuffer?.removeEventListener('updateend', onUpdateEnd);
        this.#performAudioBufferClear();
      };
      this.#audioSourceBuffer.addEventListener('updateend', onUpdateEnd);
    } else {
      this.#performAudioBufferClear();
    }
  };

  /**
   * Perform the actual buffer clear and reposition
   */
  #performAudioBufferClear = (): void => {
    if (!this.#audioSourceBuffer || !this.#videoElement) {
      return;
    }

    const currentTime: number = this.#videoElement.currentTime;

    // Clear the entire audio buffer
    const buffered: TimeRanges = this.#audioSourceBuffer.buffered;
    if (buffered.length > 0) {
      this.#audioSourceBuffer.remove(buffered.start(0), buffered.end(buffered.length - 1));

      // eslint-disable-next-line no-console
      console.log(
        `[Player] Audio buffer cleared, from position ${buffered.start(0)} to ${buffered.end(buffered.length - 1)}`
      );
    }

    // eslint-disable-next-line no-console
    this.#repositionAudioSegmentIndex(currentTime);
  };

  /**
   * Find the correct segment index based on current time and start appending
   */
  #repositionAudioSegmentIndex = (currentTime: number): void => {
    const activeSourceSegments: Array<SegmentReady> | undefined = this.#cachedAudioSegments.get(
      this.#activeSource
    );

    if (!activeSourceSegments || activeSourceSegments.length === 0) {
      this.#audioSegmentIndex = 1;
      this.#audioInitAppended = false;

      return;
    }

    // Convert currentTime (seconds) to microseconds for comparison
    const currentTimeMicros: number = currentTime * 1_000_000;

    // Find the segment that contains the current time (skip init segment at index 0)
    let newIndex: number = 1;
    for (let i: number = 1; i < activeSourceSegments.length; i++) {
      const segment: SegmentReady = activeSourceSegments[i];
      if (segment.timestamp <= currentTimeMicros) {
        newIndex = i;
      } else {
        break;
      }
    }

    this.#audioSegmentIndex = newIndex;
    this.#audioInitAppended = false;

    // eslint-disable-next-line no-console
    console.log(`[Player] Audio repositioned to segment ${newIndex} for time ${currentTime}s`);

    // Trigger audio append with new source
    this.#appendAudio();
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

  #getBufferAhead = (sourceBuffer: SourceBuffer | null): number => {
    if (!this.#videoElement || !sourceBuffer) {
      return 0;
    }

    const currentTime: number = this.#videoElement.currentTime;
    const buffered: TimeRanges = sourceBuffer.buffered;

    for (let i: number = 0; i < buffered.length; i++) {
      const start: number = buffered.start(i);
      const end: number = buffered.end(i);

      if (currentTime >= start && currentTime <= end) {
        return end - currentTime;
      }
    }

    return 0;
  };

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

    this.#appendAudio();

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

  #onAudioSegmentReady = (audioSegment: SegmentReady, sourceId: SourceId): void => {
    this.#cachedAudioSegments.get(sourceId)?.push(audioSegment);

    this.#appendAudio();
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

    if (this.#getBufferAhead(this.#videoSourceBuffer) > Player.MAX_BUFFER_AHEAD) {
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
    if (this.#disposed || !this.#audioSourceBuffer) {
      return;
    }

    if (this.#audioSourceBuffer.updating) {
      return;
    }

    if (this.#getBufferAhead(this.#audioSourceBuffer) > Player.MAX_BUFFER_AHEAD) {
      return;
    }

    const activeSourceSegments: Array<SegmentReady> | undefined = this.#cachedAudioSegments.get(
      this.#activeSource
    );

    if (!activeSourceSegments) return;

    let segmentToAppend: SegmentReady | null = null;
    if (!this.#audioInitAppended) {
      segmentToAppend = activeSourceSegments[0];
      if (segmentToAppend) {
        this.#audioInitAppended = true;
      }
    } else {
      segmentToAppend = activeSourceSegments[this.#audioSegmentIndex];
      if (segmentToAppend) {
        this.#audioSegmentIndex++;
      }
    }

    if (segmentToAppend) {
      try {
        this.#audioSourceBuffer.appendBuffer(segmentToAppend.data as BufferSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[Player] Audio appendBuffer error:', e);
      }
    }
  };

  #onVideoUpdateEnd = (): void => {
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
