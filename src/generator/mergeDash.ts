import Decoder, {type AudioSourceId} from '@decoder/decoder';
import IEncodedChunk from '@interfaces/IEncodedChunk';

import generateDash from './dash';

// Two DASH MPD URLs (clear, no DRM)
const DASH_URL_1: string = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const DASH_URL_2: string =
  'https://bitmovin-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd';

const WIDTH: number = 640;
const HEIGHT: number = 480;
const MIN_PIP_SIZE: number = 80;
const RESIZE_HANDLE_SIZE: number = 15;

export type SwapCallback = (swapped: boolean) => void;
export type {AudioSourceId};

export interface MergeDashOptions {
  signal?: AbortSignal;
  onSwap?: SwapCallback;
  onAudioChunk?: (chunk: IEncodedChunk, sourceId: AudioSourceId) => void;
  // MSE player controls fetching - wait function that resolves when buffer needs data
  waitUntilBufferNeeded?: () => Promise<void>;
}

/**
 * Start fetching DASH segments and feeding them to decoder
 * MSE player controls fetching via waitUntilBufferNeeded
 */
async function startDashFetching(
  mpdUrl: string,
  decoder: Decoder,
  signal?: AbortSignal,
  waitUntilBufferNeeded?: () => Promise<void>
): Promise<void> {
  for await (const chunk of generateDash({mpdUrl, signal})) {
    if (signal?.aborted) break;

    // MSE player controls fetching - wait until buffer needs more data
    if (waitUntilBufferNeeded) {
      // eslint-disable-next-line no-await-in-loop
      await waitUntilBufferNeeded();
    }

    if (signal?.aborted) break;
    decoder.feedData(chunk.data, chunk.type);
  }

  // Mark decoder as ended when all segments have been fetched
  decoder.setEnded();
  // eslint-disable-next-line no-console
  console.log(`[DASH] Finished fetching all segments for ${mpdUrl}`);
}

/**
 * Generator that yields composited VideoFrames from two DASH streams
 */
async function* generate(options: MergeDashOptions = {}): AsyncGenerator<VideoFrame> {
  const {signal, onSwap, onAudioChunk, waitUntilBufferNeeded} = options;

  // eslint-disable-next-line no-console
  console.log('[MergeDash] Starting merge from two DASH streams');

  // State to track which stream is in background vs PiP
  let swapped: boolean = false;

  // PiP position and size
  let pipX: number = WIDTH - WIDTH / 3 - 10;
  let pipY: number = HEIGHT - HEIGHT / 3 - 10;
  let pipWidth: number = WIDTH / 3;
  let pipHeight: number = HEIGHT / 3;

  // Drag & resize state
  let isDragging: boolean = false;
  let isResizing: boolean = false;
  let dragOffsetX: number = 0;
  let dragOffsetY: number = 0;

  // Use video element for mouse interactions (MSE output)
  const outputElement: HTMLVideoElement | null = document.getElementById('tiled-player') as HTMLVideoElement;

  const isInPipArea = (x: number, y: number): boolean => {
    return x >= pipX && x <= pipX + pipWidth && y >= pipY && y <= pipY + pipHeight;
  };

  const isInResizeHandle = (x: number, y: number): boolean => {
    return (
      x >= pipX + pipWidth - RESIZE_HANDLE_SIZE &&
      x <= pipX + pipWidth &&
      y >= pipY + pipHeight - RESIZE_HANDLE_SIZE &&
      y <= pipY + pipHeight
    );
  };

  // Mouse event handlers
  const handleMouseDown = (e: MouseEvent): void => {
    const rect: DOMRect = (e.target as HTMLElement).getBoundingClientRect();
    const scaleX: number = WIDTH / rect.width;
    const scaleY: number = HEIGHT / rect.height;
    const x: number = (e.clientX - rect.left) * scaleX;
    const y: number = (e.clientY - rect.top) * scaleY;

    if (isInResizeHandle(x, y)) {
      isResizing = true;
    } else if (isInPipArea(x, y)) {
      isDragging = true;
      dragOffsetX = x - pipX;
      dragOffsetY = y - pipY;
    }
  };

  const handleMouseMove = (e: MouseEvent): void => {
    const rect: DOMRect = (e.target as HTMLElement).getBoundingClientRect();
    const scaleX: number = WIDTH / rect.width;
    const scaleY: number = HEIGHT / rect.height;
    const x: number = (e.clientX - rect.left) * scaleX;
    const y: number = (e.clientY - rect.top) * scaleY;

    if (isDragging) {
      pipX = Math.max(0, Math.min(WIDTH - pipWidth, x - dragOffsetX));
      pipY = Math.max(0, Math.min(HEIGHT - pipHeight, y - dragOffsetY));
    } else if (isResizing) {
      pipWidth = Math.max(MIN_PIP_SIZE, Math.min(WIDTH - pipX, x - pipX));
      pipHeight = Math.max(MIN_PIP_SIZE, Math.min(HEIGHT - pipY, y - pipY));
    }
  };

  const handleMouseUp = (): void => {
    isDragging = false;
    isResizing = false;
  };

  const handleDoubleClick = (): void => {
    swapped = !swapped;
    onSwap?.(swapped);
  };

  if (outputElement) {
    outputElement.addEventListener('mousedown', handleMouseDown);
    outputElement.addEventListener('mousemove', handleMouseMove);
    outputElement.addEventListener('mouseup', handleMouseUp);
    outputElement.addEventListener('mouseleave', handleMouseUp);
    outputElement.addEventListener('dblclick', handleDoubleClick);
  }

  // Create two DASH decoders - both send audio to the callback
  // MSEPlayer will handle filtering and timestamp management
  const decoder1: Decoder = new Decoder('dash1', onAudioChunk, signal);
  const decoder2: Decoder = new Decoder('dash2', onAudioChunk, signal);

  // Start fetching DASH segments in background
  // MSE player controls fetching via waitUntilBufferNeeded
  startDashFetching(DASH_URL_1, decoder1, signal, waitUntilBufferNeeded);
  startDashFetching(DASH_URL_2, decoder2, signal, waitUntilBufferNeeded);

  // Wait for initial frames
  // eslint-disable-next-line no-console
  console.log('[MergeDash] Waiting for initial frames...');
  while (decoder1.frames.length < 5 || decoder2.frames.length < 5) {
    if (signal?.aborted) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 100));
  }
  // eslint-disable-next-line no-console
  console.log('[MergeDash] Got initial frames, starting compositing');

  // Create OffscreenCanvas for compositing
  const canvas: OffscreenCanvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx: OffscreenCanvasRenderingContext2D | null = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  const frameInterval: number = 1000 / 30; // 30 FPS
  let lastFrameTime: number = 0;
  let frameCount: number = 0;

  try {
    while (!signal?.aborted) {
      const now: number = performance.now();
      if (now - lastFrameTime < frameInterval) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 5));
        continue;
      }
      lastFrameTime = now;

      // Get frames from decoders
      const frame1: VideoFrame | undefined = decoder1.getFrame();
      const frame2: VideoFrame | undefined = decoder2.getFrame();

      if (!frame1 && !frame2) {
        // Check if both streams have ended and no more frames
        const bothEnded: boolean = decoder1.isEnded() && decoder2.isEnded();
        const noMoreFrames: boolean = decoder1.frames.length === 0 && decoder2.frames.length === 0;
        if (bothEnded && noMoreFrames) {
          // eslint-disable-next-line no-console
          console.log('[MergeDash] Both streams ended, stopping playback');
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r: (value: unknown) => void): number => window.setTimeout(r, 10));
        continue;
      }

      // Determine which frame is background and which is PiP
      const bgFrame: VideoFrame | undefined = swapped ? frame2 : frame1;
      const pipFrame: VideoFrame | undefined = swapped ? frame1 : frame2;

      // Draw background (full canvas)
      if (bgFrame) {
        ctx.drawImage(bgFrame, 0, 0, WIDTH, HEIGHT);
        bgFrame.close();
      }

      // Draw PiP with border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(pipX - 1, pipY - 1, pipWidth + 2, pipHeight + 2);
      if (pipFrame) {
        ctx.drawImage(pipFrame, pipX, pipY, pipWidth, pipHeight);
        pipFrame.close();
      }

      // Draw resize handle
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(
        pipX + pipWidth - RESIZE_HANDLE_SIZE,
        pipY + pipHeight - RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE
      );

      // Create VideoFrame
      const timestamp: number = frameCount * (1000000 / 30);
      const frame: VideoFrame = new VideoFrame(canvas, {timestamp});
      frameCount++;

      yield frame;
    }
  } finally {
    // Cleanup
    if (outputElement) {
      outputElement.removeEventListener('mousedown', handleMouseDown);
      outputElement.removeEventListener('mousemove', handleMouseMove);
      outputElement.removeEventListener('mouseup', handleMouseUp);
      outputElement.removeEventListener('mouseleave', handleMouseUp);
      outputElement.removeEventListener('dblclick', handleDoubleClick);
    }
    decoder1.destroy();
    decoder2.destroy();
  }
}

export default generate;
