/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  createFile,
  DataStream,
  type ISOFile,
  type Sample,
  type Track,
  type Movie,
  MP4BoxBuffer,
  SampleEntry,
  Endianness
} from 'mp4box';

/**
 * Decoder - Decodes a single  stream
 * Uses mp4box.js for demuxing and WebCodecs for decoding
 * Outputs decoded VideoFrame
 */
class Decoder {
  #signal: AbortSignal;

  // Video frames buffer (decoded)
  #videoFrames: Array<VideoFrame> = [];

  #videoFileOffset: number = 0;

  #videoDecoder: VideoDecoder;

  #videoMp4File: ISOFile;

  #videoTrackId: number | null = null;

  constructor(signal: AbortSignal) {
    this.#signal = signal;

    // Video decoder - outputs to #videoFrames buffer
    this.#videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame): void => {
        this.#videoFrames.push(frame);
      },
      error: (e: DOMException): void => {
        // eslint-disable-next-line no-console
        console.error(`VideoDecoder error:`, e);
      }
    });

    // MP4 demuxer
    this.#videoMp4File = createFile();

    this.#setupVideoMp4Callbacks();
  }

  get videoFrames(): Array<VideoFrame> {
    return this.#videoFrames;
  }

  getVideoFrame = (): VideoFrame | undefined => this.#videoFrames.shift();

  feedData = (data: Uint8Array): void => {
    const buffer: MP4BoxBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as MP4BoxBuffer;
    buffer.fileStart = this.#videoFileOffset;
    this.#videoFileOffset += data.byteLength;
    this.#videoMp4File.appendBuffer(buffer);
  };

  destroy = (): void => {
    this.#videoMp4File.flush();
    this.#videoDecoder.close();

    // Close all video frames
    this.#videoFrames.forEach((f: VideoFrame) => f.close());
    this.#videoFrames.length = 0;
  };

  #setupVideoMp4Callbacks = (): void => {
    this.#videoMp4File.onReady = (info: Movie): void => {
      // eslint-disable-next-line no-console
      console.log(`Video MP4Box ready:`, info);

      const videoTrack: Track | undefined = info.videoTracks[0];
      if (videoTrack) {
        this.#videoTrackId = videoTrack.id;

        const description: Uint8Array | undefined = this.#getCodecDescription(
          this.#videoMp4File,
          videoTrack.id
        );

        const config: VideoDecoderConfig = {
          codec: videoTrack.codec,
          codedWidth: videoTrack.video?.width || 640,
          codedHeight: videoTrack.video?.height || 480,
          description
        };

        // eslint-disable-next-line no-console
        console.log(`Configuring video decoder:`, config);
        this.#videoDecoder.configure(config);

        this.#videoMp4File.setExtractionOptions(videoTrack.id, null, {nbSamples: 50});
        this.#videoMp4File.start();
      }
    };

    this.#videoMp4File.onSamples = (trackId: number, _ref: unknown, samples: Array<Sample>): void => {
      if (trackId !== this.#videoTrackId) return;

      for (const sample of samples) {
        if (this.#signal.aborted || !sample.data) break;

        const chunk: EncodedVideoChunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1000000) / sample.timescale,
          duration: (sample.duration * 1000000) / sample.timescale,
          data: sample.data
        });

        this.#videoDecoder.decode(chunk);
      }
    };
  };

  #getCodecDescription = (mp4File: ISOFile, trackId: number): Uint8Array | undefined => {
    const trak: any = mp4File.getTrackById(trackId);
    if (!trak) return undefined;

    const entries: Array<SampleEntry> = trak.mdia?.minf?.stbl?.stsd?.entries;
    if (!entries || entries.length === 0) return undefined;

    const entry: SampleEntry = entries[0];

    if ((entry as any).avcC) {
      const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      (entry as any).avcC.write(stream);

      return new Uint8Array(stream.buffer, 8);
    }

    if ((entry as any).hvcC) {
      const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      (entry as any).hvcC.write(stream);

      return new Uint8Array(stream.buffer, 8);
    }

    return undefined;
  };
}

export default Decoder;
