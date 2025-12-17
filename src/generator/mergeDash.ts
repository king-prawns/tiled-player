/* eslint-disable @typescript-eslint/no-explicit-any */

import IEncodedChunk from '@interfaces/IEncodedChunk';
import {
  createFile,
  DataStream,
  type ISOFile,
  type Sample,
  type Track,
  type Movie,
  Endianness,
  MP4BoxBuffer
} from 'mp4box';

import generateDash from './dash';

// Two DASH MPD URLs (clear, no DRM)
const DASH_URL_1: string = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const DASH_URL_2: string =
  'https://bitmovin-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd';

const WIDTH: number = 640;
const HEIGHT: number = 480;
const MIN_PIP_SIZE: number = 80;
const RESIZE_HANDLE_SIZE: number = 15;
const AUDIO_SAMPLE_RATE: number = 48000;

export type SwapCallback = (swapped: boolean) => void;
export type AudioSourceId = 'dash1' | 'dash2';

export interface MergeDashOptions {
  signal?: AbortSignal;
  onSwap?: SwapCallback;
  onAudioChunk?: (chunk: IEncodedChunk, sourceId: AudioSourceId) => void;
  // MSE player controls fetching - wait function that resolves when buffer needs data
  waitUntilBufferNeeded?: () => Promise<void>;
}

interface DashDecoder {
  frames: Array<VideoFrame>;
  feedData: (data: Uint8Array, type: 'video' | 'audio') => void;
  getFrame: () => VideoFrame | undefined;
  destroy: () => void;
  isEnded: () => boolean;
  // Mark this decoder as ended (no more segments)
  setEnded: () => void;
}

/**
 * Get codec description from mp4box track using getTrackById and sample entry
 * Uses mp4box's DataStream to serialize the configuration box
 */
function getCodecDescription(mp4File: ISOFile, trackId: number): Uint8Array | undefined {
  // Get track info
  const trak: any = mp4File.getTrackById(trackId);
  if (!trak) return undefined;

  const entries: any = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return undefined;

  const entry: any = entries[0];

  // For AVC/H.264, we need the avcC box
  if (entry.avcC) {
    // Use mp4box's DataStream to serialize the box
    const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    entry.avcC.write(stream);
    // Skip first 8 bytes (box size + box type)

    return new Uint8Array(stream.buffer, 8);
  }

  // For HEVC/H.265, we need the hvcC box
  if (entry.hvcC) {
    const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    entry.hvcC.write(stream);

    return new Uint8Array(stream.buffer, 8);
  }

  return undefined;
}

/**
 * Create a VideoDecoder-based DASH decoder using mp4box.js for demuxing
 * Also handles audio decoding and re-encoding to Opus
 */
function createDashDecoder(
  sourceId: AudioSourceId,
  onAudioChunk?: (chunk: IEncodedChunk, sourceId: AudioSourceId) => void,
  signal?: AbortSignal
): DashDecoder {
  const frames: Array<VideoFrame> = [];
  let videoFileOffset: number = 0;
  let audioFileOffset: number = 0;
  let hasEnded: boolean = false;

  // Video decoder
  const videoDecoder: VideoDecoder = new VideoDecoder({
    output: (frame: VideoFrame): void => {
      frames.push(frame);
    },
    error: (e: DOMException): void => {
      // eslint-disable-next-line no-console
      console.error(`[${sourceId}] VideoDecoder error:`, e);
    }
  });

  // Audio encoder (re-encode to Opus for WebM)
  let audioEncoder: AudioEncoder | null = null;
  if (onAudioChunk) {
    audioEncoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk): void => {
        const data: Uint8Array = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        onAudioChunk({data, timestamp: chunk.timestamp, key: chunk.type === 'key'}, sourceId);
      },
      error: (e: DOMException): void => {
        // eslint-disable-next-line no-console
        console.error(`[${sourceId}] AudioEncoder error:`, e);
      }
    });
    audioEncoder.configure({
      codec: 'opus',
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: 128000
    });
  }

  // Audio decoder (decode AAC from DASH)
  let audioDecoder: AudioDecoder | null = null;
  if (onAudioChunk) {
    audioDecoder = new AudioDecoder({
      output: (audioData: AudioData): void => {
        // Re-encode to Opus
        if (audioEncoder && audioEncoder.state === 'configured') {
          audioEncoder.encode(audioData);
        }
        audioData.close();
      },
      error: (e: DOMException): void => {
        // eslint-disable-next-line no-console
        console.error(`[${sourceId}] AudioDecoder error:`, e);
      }
    });
  }

  // MP4 demuxers
  const videoMp4File: ISOFile = createFile();
  const audioMp4File: ISOFile = createFile();
  let videoTrackId: number | null = null;
  let audioTrackId: number | null = null;

  // Video MP4 callbacks
  videoMp4File.onReady = (info: Movie): void => {
    // eslint-disable-next-line no-console
    console.log(`[${sourceId}] Video MP4Box ready:`, info);

    const videoTrack: Track | undefined = info.videoTracks[0];
    if (videoTrack) {
      videoTrackId = videoTrack.id;

      const description: Uint8Array | undefined = getCodecDescription(videoMp4File, videoTrack.id);
      const config: VideoDecoderConfig = {
        codec: videoTrack.codec,
        codedWidth: videoTrack.video?.width || 640,
        codedHeight: videoTrack.video?.height || 480,
        description
      };

      // eslint-disable-next-line no-console
      console.log(`[${sourceId}] Configuring video decoder:`, config);
      videoDecoder.configure(config);

      videoMp4File.setExtractionOptions(videoTrack.id, null, {nbSamples: 50});
      videoMp4File.start();
    }
  };

  videoMp4File.onSamples = (trackId: number, _ref: unknown, samples: Array<Sample>): void => {
    if (trackId !== videoTrackId) return;

    for (const sample of samples) {
      if (signal?.aborted || !sample.data) break;

      const chunk: EncodedVideoChunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: (sample.cts * 1000000) / sample.timescale,
        duration: (sample.duration * 1000000) / sample.timescale,
        data: sample.data
      });

      videoDecoder.decode(chunk);
    }
  };

  // Audio MP4 callbacks
  audioMp4File.onReady = async (info: Movie): Promise<void> => {
    if (!audioDecoder) return;

    // eslint-disable-next-line no-console
    console.log(`[${sourceId}] Audio MP4Box ready:`, info);

    const audioTrack: Track | undefined = info.audioTracks[0];
    if (audioTrack) {
      audioTrackId = audioTrack.id;

      // Get codec string - mp4a.40.2 for AAC-LC
      const codec: string = audioTrack.codec || 'mp4a.40.2';
      const sampleRate: number = audioTrack.audio?.sample_rate || 48000;
      const numberOfChannels: number = audioTrack.audio?.channel_count || 2;

      // Get audio codec description (esds box for AAC)
      const description: Uint8Array | undefined = getAudioCodecDescription(audioMp4File, audioTrack.id);

      const config: AudioDecoderConfig = {
        codec,
        sampleRate,
        numberOfChannels,
        description
      };

      // Check if this configuration is supported
      try {
        const support: AudioDecoderSupport = await AudioDecoder.isConfigSupported(config);
        if (!support.supported) {
          // eslint-disable-next-line no-console
          console.warn(`[${sourceId}] Audio decoder config not supported (${codec}), skipping audio`);
          audioDecoder?.close();
          audioDecoder = null;
          audioEncoder?.close();

          return;
        }

        // eslint-disable-next-line no-console
        console.log(`[${sourceId}] Configuring audio decoder:`, config);
        audioDecoder.configure(config);

        audioMp4File.setExtractionOptions(audioTrack.id, null, {nbSamples: 100});
        audioMp4File.start();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[${sourceId}] Audio decoder configuration failed:`, e);
        audioDecoder?.close();
        audioDecoder = null;
        audioEncoder?.close();
      }
    }
  };

  audioMp4File.onSamples = (trackId: number, _ref: unknown, samples: Array<Sample>): void => {
    if (trackId !== audioTrackId || !audioDecoder || audioDecoder.state !== 'configured') return;

    for (const sample of samples) {
      if (signal?.aborted || !sample.data || !audioDecoder || audioDecoder.state !== 'configured') break;

      const chunk: EncodedAudioChunk = new EncodedAudioChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: (sample.cts * 1000000) / sample.timescale,
        duration: (sample.duration * 1000000) / sample.timescale,
        data: sample.data
      });

      audioDecoder.decode(chunk);
    }
  };

  const feedData = (data: Uint8Array, type: 'video' | 'audio'): void => {
    if (type === 'video') {
      const buffer: MP4BoxBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as MP4BoxBuffer;
      buffer.fileStart = videoFileOffset;
      videoFileOffset += data.byteLength;
      videoMp4File.appendBuffer(buffer);
    } else {
      const buffer: MP4BoxBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as MP4BoxBuffer;
      buffer.fileStart = audioFileOffset;
      audioFileOffset += data.byteLength;
      audioMp4File.appendBuffer(buffer);
    }
  };

  const getFrame = (): VideoFrame | undefined => frames.shift();

  const destroy = (): void => {
    videoMp4File.flush();
    audioMp4File.flush();
    videoDecoder.close();
    audioDecoder?.close();
    audioEncoder?.close();
    frames.forEach((f: VideoFrame) => f.close());
    frames.length = 0;
    hasEnded = true;
  };

  const isEnded = (): boolean => hasEnded;

  const setEnded = (): void => {
    hasEnded = true;
  };

  return {frames, feedData, getFrame, destroy, isEnded, setEnded};
}

/**
 * Get audio codec description (AudioSpecificConfig for AAC)
 * WebCodecs expects AudioSpecificConfig, not the full esds box
 * AudioSpecificConfig is typically 2-5 bytes inside the esds box
 */
function getAudioCodecDescription(mp4File: ISOFile, trackId: number): Uint8Array | undefined {
  const trak: any = mp4File.getTrackById(trackId);
  if (!trak) return undefined;

  const entries: any = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return undefined;

  const entry: any = entries[0];

  // For AAC, we need the AudioSpecificConfig from the esds box
  if (entry.esds) {
    // The esds box contains decoder-specific info
    // We need to extract AudioSpecificConfig from it
    // Path: esds -> ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo

    // Try to get decoderSpecificInfo directly if mp4box parsed it
    const esds: any = entry.esds;
    if (esds.esd?.descs) {
      // Look for DecoderSpecificInfo (tag 0x05)
      for (const desc of esds.esd.descs) {
        if (desc.tag === 0x04 && desc.descs) {
          // DecoderConfigDescriptor
          for (const subDesc of desc.descs) {
            if (subDesc.tag === 0x05 && subDesc.data) {
              // DecoderSpecificInfo - contains AudioSpecificConfig
              return new Uint8Array(subDesc.data);
            }
          }
        }
      }
    }

    // Fallback: serialize the full esds and extract AudioSpecificConfig manually
    const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    entry.esds.write(stream);
    const esdsData: Uint8Array = new Uint8Array(stream.buffer);

    // Parse esds to find AudioSpecificConfig
    // Skip box header (8 bytes) and look for tag 0x05
    const audioSpecificConfig: Uint8Array | undefined = extractAudioSpecificConfig(esdsData);
    if (audioSpecificConfig) {
      return audioSpecificConfig;
    }

    // Last fallback: return data after box header
    return new Uint8Array(stream.buffer, 8);
  }

  return undefined;
}

/**
 * Extract AudioSpecificConfig from esds box data
 * Parses the descriptor hierarchy to find tag 0x05 (DecoderSpecificInfo)
 */
function extractAudioSpecificConfig(esdsData: Uint8Array): Uint8Array | undefined {
  // Skip box header (8 bytes: 4 size + 4 type 'esds')
  // Then skip version (1) and flags (3)
  let offset: number = 8 + 4;

  while (offset < esdsData.length) {
    const tag: number = esdsData[offset++];
    if (offset >= esdsData.length) break;

    // Parse length (variable length encoding)
    let length: number = 0;
    for (let i: number = 0; i < 4; i++) {
      const byte: number = esdsData[offset++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }

    if (tag === 0x05) {
      // DecoderSpecificInfo - this contains AudioSpecificConfig
      return esdsData.slice(offset, offset + length);
    }

    // For tags 0x03 (ES_Descriptor) and 0x04 (DecoderConfigDescriptor),
    // we need to descend into them, so don't skip their content
    if (tag === 0x03) {
      // ES_Descriptor: skip ES_ID (2) and flags (1)
      offset += 3;
    } else if (tag === 0x04) {
      // DecoderConfigDescriptor: skip objectTypeIndication (1), streamType (4 bits),
      // upStream (1 bit), reserved (1 bit), bufferSizeDB (3 bytes),
      // maxBitrate (4), avgBitrate (4) = 13 bytes
      offset += 13;
    } else {
      // Skip unknown tags
      offset += length;
    }
  }

  return undefined;
}

/**
 * Start fetching DASH segments and feeding them to decoder
 * MSE player controls fetching via waitUntilBufferNeeded
 */
async function startDashFetching(
  mpdUrl: string,
  decoder: DashDecoder,
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
  const decoder1: DashDecoder = createDashDecoder('dash1', onAudioChunk, signal);
  const decoder2: DashDecoder = createDashDecoder('dash2', onAudioChunk, signal);

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
