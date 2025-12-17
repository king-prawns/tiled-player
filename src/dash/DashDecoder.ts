/* eslint-disable @typescript-eslint/no-explicit-any */

import IEncodedChunk from '@interfaces/IEncodedChunk';
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

export type AudioSourceId = 'dash1' | 'dash2';

const AUDIO_SAMPLE_RATE: number = 48000;

/**
 * DashDecoder - Decodes a single DASH stream (video + audio)
 * Uses mp4box.js for demuxing and WebCodecs for decoding
 */
class DashDecoder {
  #sourceId: AudioSourceId;
  #signal?: AbortSignal;
  #onAudioChunk?: (chunk: IEncodedChunk, sourceId: AudioSourceId) => void;

  #frames: Array<VideoFrame> = [];
  #videoFileOffset: number = 0;
  #audioFileOffset: number = 0;
  #hasEnded: boolean = false;

  #videoDecoder: VideoDecoder;
  #audioDecoder: AudioDecoder | null = null;
  #audioEncoder: AudioEncoder | null = null;

  #videoMp4File: ISOFile;
  #audioMp4File: ISOFile;
  #videoTrackId: number | null = null;
  #audioTrackId: number | null = null;

  constructor(
    sourceId: AudioSourceId,
    onAudioChunk?: (chunk: IEncodedChunk, sourceId: AudioSourceId) => void,
    signal?: AbortSignal
  ) {
    this.#sourceId = sourceId;
    this.#signal = signal;
    this.#onAudioChunk = onAudioChunk;

    // Video decoder
    this.#videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame): void => {
        this.#frames.push(frame);
      },
      error: (e: DOMException): void => {
        // eslint-disable-next-line no-console
        console.error(`[${sourceId}] VideoDecoder error:`, e);
      }
    });

    // Audio encoder (re-encode to Opus for WebM)
    if (onAudioChunk) {
      this.#audioEncoder = new AudioEncoder({
        output: (chunk: EncodedAudioChunk): void => {
          const data: Uint8Array = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.#onAudioChunk?.({data, timestamp: chunk.timestamp, key: chunk.type === 'key'}, this.#sourceId);
        },
        error: (e: DOMException): void => {
          // eslint-disable-next-line no-console
          console.error(`[${sourceId}] AudioEncoder error:`, e);
        }
      });
      this.#audioEncoder.configure({
        codec: 'opus',
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: 2,
        bitrate: 128000
      });

      // Audio decoder
      this.#audioDecoder = new AudioDecoder({
        output: (audioData: AudioData): void => {
          if (this.#audioEncoder && this.#audioEncoder.state === 'configured') {
            this.#audioEncoder.encode(audioData);
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
    this.#videoMp4File = createFile();
    this.#audioMp4File = createFile();

    this.#setupVideoMp4Callbacks();
    this.#setupAudioMp4Callbacks();
  }

  get frames(): Array<VideoFrame> {
    return this.#frames;
  }

  getFrame = (): VideoFrame | undefined => this.#frames.shift();

  isEnded = (): boolean => this.#hasEnded;

  setEnded = (): void => {
    this.#hasEnded = true;
  };

  feedData = (data: Uint8Array, type: 'video' | 'audio'): void => {
    if (type === 'video') {
      const buffer: MP4BoxBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as MP4BoxBuffer;
      buffer.fileStart = this.#videoFileOffset;
      this.#videoFileOffset += data.byteLength;
      this.#videoMp4File.appendBuffer(buffer);
    } else {
      const buffer: MP4BoxBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as MP4BoxBuffer;
      buffer.fileStart = this.#audioFileOffset;
      this.#audioFileOffset += data.byteLength;
      this.#audioMp4File.appendBuffer(buffer);
    }
  };

  destroy = (): void => {
    this.#videoMp4File.flush();
    this.#audioMp4File.flush();
    this.#videoDecoder.close();
    this.#audioDecoder?.close();
    this.#audioEncoder?.close();
    this.#frames.forEach((f: VideoFrame) => f.close());
    this.#frames.length = 0;
    this.#hasEnded = true;
  };

  #setupVideoMp4Callbacks = (): void => {
    this.#videoMp4File.onReady = (info: Movie): void => {
      // eslint-disable-next-line no-console
      console.log(`[${this.#sourceId}] Video MP4Box ready:`, info);

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
        console.log(`[${this.#sourceId}] Configuring video decoder:`, config);
        this.#videoDecoder.configure(config);

        this.#videoMp4File.setExtractionOptions(videoTrack.id, null, {nbSamples: 50});
        this.#videoMp4File.start();
      }
    };

    this.#videoMp4File.onSamples = (trackId: number, _ref: unknown, samples: Array<Sample>): void => {
      if (trackId !== this.#videoTrackId) return;

      for (const sample of samples) {
        if (this.#signal?.aborted || !sample.data) break;

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

  #setupAudioMp4Callbacks = (): void => {
    this.#audioMp4File.onReady = async (info: Movie): Promise<void> => {
      if (!this.#audioDecoder) return;

      // eslint-disable-next-line no-console
      console.log(`[${this.#sourceId}] Audio MP4Box ready:`, info);

      const audioTrack: Track | undefined = info.audioTracks[0];
      if (audioTrack) {
        this.#audioTrackId = audioTrack.id;

        const codec: string = audioTrack.codec || 'mp4a.40.2';
        const sampleRate: number = audioTrack.audio?.sample_rate || 48000;
        const numberOfChannels: number = audioTrack.audio?.channel_count || 2;

        const description: Uint8Array | undefined = this.#getAudioCodecDescription(
          this.#audioMp4File,
          audioTrack.id
        );

        const config: AudioDecoderConfig = {
          codec,
          sampleRate,
          numberOfChannels,
          description
        };

        try {
          const support: AudioDecoderSupport = await AudioDecoder.isConfigSupported(config);
          if (!support.supported) {
            // eslint-disable-next-line no-console
            console.warn(`[${this.#sourceId}] Audio decoder config not supported (${codec}), skipping audio`);
            this.#audioDecoder?.close();
            this.#audioDecoder = null;
            this.#audioEncoder?.close();

            return;
          }

          // eslint-disable-next-line no-console
          console.log(`[${this.#sourceId}] Configuring audio decoder:`, config);
          this.#audioDecoder.configure(config);

          this.#audioMp4File.setExtractionOptions(audioTrack.id, null, {nbSamples: 100});
          this.#audioMp4File.start();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[${this.#sourceId}] Audio decoder configuration failed:`, e);
          this.#audioDecoder?.close();
          this.#audioDecoder = null;
          this.#audioEncoder?.close();
        }
      }
    };

    this.#audioMp4File.onSamples = (trackId: number, _ref: unknown, samples: Array<Sample>): void => {
      if (trackId !== this.#audioTrackId || !this.#audioDecoder || this.#audioDecoder.state !== 'configured')
        return;

      for (const sample of samples) {
        if (
          this.#signal?.aborted ||
          !sample.data ||
          !this.#audioDecoder ||
          this.#audioDecoder.state !== 'configured'
        )
          break;

        const chunk: EncodedAudioChunk = new EncodedAudioChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1000000) / sample.timescale,
          duration: (sample.duration * 1000000) / sample.timescale,
          data: sample.data
        });

        this.#audioDecoder.decode(chunk);
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

  #getAudioCodecDescription = (mp4File: ISOFile, trackId: number): Uint8Array | undefined => {
    const trak: any = mp4File.getTrackById(trackId);
    if (!trak) return undefined;

    const entries: Array<SampleEntry> = trak.mdia?.minf?.stbl?.stsd?.entries;
    if (!entries || entries.length === 0) return undefined;

    const entry: SampleEntry = entries[0];

    if ((entry as any).esds) {
      const esds: any = (entry as any).esds;
      if (esds.esd?.descs) {
        for (const desc of esds.esd.descs) {
          if (desc.tag === 0x04 && desc.descs) {
            for (const subDesc of desc.descs) {
              if (subDesc.tag === 0x05 && subDesc.data) {
                return new Uint8Array(subDesc.data);
              }
            }
          }
        }
      }

      const stream: DataStream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      (entry as any).esds.write(stream);
      const esdsData: Uint8Array = new Uint8Array(stream.buffer);

      const audioSpecificConfig: Uint8Array<ArrayBufferLike> | undefined =
        this.#extractAudioSpecificConfig(esdsData);
      if (audioSpecificConfig) {
        return audioSpecificConfig;
      }

      return new Uint8Array(stream.buffer, 8);
    }

    return undefined;
  };

  #extractAudioSpecificConfig = (esdsData: Uint8Array): Uint8Array | undefined => {
    let offset: number = 8 + 4;

    while (offset < esdsData.length) {
      const tag: number = esdsData[offset++];
      if (offset >= esdsData.length) break;

      let length: number = 0;
      for (let i: number = 0; i < 4; i++) {
        const byte: number = esdsData[offset++];
        length = (length << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }

      if (tag === 0x05) {
        return esdsData.slice(offset, offset + length);
      }

      if (tag === 0x03) {
        offset += 3;
      } else if (tag === 0x04) {
        offset += 13;
      } else {
        offset += length;
      }
    }

    return undefined;
  };
}

export default DashDecoder;
