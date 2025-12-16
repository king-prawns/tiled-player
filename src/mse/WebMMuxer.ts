import IEncodedChunk from '@interfaces/IEncodedChunk';
import IEncodedAudioChunk from '@interfaces/IEncodedAudioChunk';

export interface IMuxedChunk {
  data: Uint8Array;
  isVideo: boolean;
  timestamp: number;
}

/**
 * WebM muxer for VP8 video and Opus audio
 * Creates WebM container from raw VP8/Opus frames
 * Can be configured for video-only, audio-only, or both
 */
class WebMMuxer {
  #width: number;
  #height: number;
  #sampleRate: number;
  #type: 'audio' | 'video';

  #videoTrackNumber: number = 1;
  #audioTrackNumber: number = 1;

  constructor(
    width: number = 640,
    height: number = 480,
    sampleRate: number = 48000,
    type: 'audio' | 'video' = 'video'
  ) {
    this.#width = width;
    this.#height = height;
    this.#sampleRate = sampleRate;
    this.#type = type;
  }

  /**
   * Generate WebM initialization segment (EBML header + Segment info + Tracks)
   */
  getInitSegment(): Uint8Array {
    const data: number[] = [];

    // EBML Header
    this.#writeEBMLHeader(data);

    // Segment (unknown size - 0x01FFFFFFFFFFFFFF)
    data.push(0x18, 0x53, 0x80, 0x67); // Segment ID
    data.push(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff); // Unknown size

    // Segment Info
    this.#writeSegmentInfo(data);

    // Tracks
    this.#writeTracks(data);

    return new Uint8Array(data);
  }

  /**
   * Mux a video chunk into WebM cluster format
   * For MSE: each chunk needs a complete cluster with known size
   */
  muxVideoChunk(chunk: IEncodedChunk): Uint8Array {
    const timestampMs: number = Math.floor(chunk.timestamp / 1000);

    // Create SimpleBlock first to know its size
    const simpleBlock: number[] = this.#createSimpleBlock(
      this.#videoTrackNumber,
      chunk.data,
      0, // Relative timestamp is 0 since cluster timestamp = chunk timestamp
      chunk.key
    );

    // Build SimpleBlock element (ID + size + data)
    const simpleBlockElement: number[] = [];
    simpleBlockElement.push(0xa3); // SimpleBlock ID
    this.#writeVINT(simpleBlockElement, simpleBlock.length);
    simpleBlockElement.push(...simpleBlock);

    // Build Timecode element
    const timecodeValue: number[] = this.#encodeUnsignedInt(timestampMs);
    const timecodeElement: number[] = [];
    timecodeElement.push(0xe7); // Timecode ID
    this.#writeVINT(timecodeElement, timecodeValue.length);
    timecodeElement.push(...timecodeValue);

    // Calculate cluster content size
    const clusterContentSize: number = timecodeElement.length + simpleBlockElement.length;

    // Build complete cluster with known size
    const data: number[] = [];
    data.push(0x1f, 0x43, 0xb6, 0x75); // Cluster ID
    this.#writeVINT(data, clusterContentSize);
    data.push(...timecodeElement);
    data.push(...simpleBlockElement);

    return new Uint8Array(data);
  }

  /**
   * Mux an audio chunk into WebM cluster format
   * For MSE: each chunk needs a complete cluster with known size
   */
  muxAudioChunk(chunk: IEncodedAudioChunk): Uint8Array {
    const timestampMs: number = Math.floor(chunk.timestamp / 1000);

    // Create SimpleBlock first to know its size
    const simpleBlock: number[] = this.#createSimpleBlock(
      this.#audioTrackNumber,
      chunk.data,
      0, // Relative timestamp is 0 since cluster timestamp = chunk timestamp
      true // Audio frames are always keyframes for Opus
    );

    // Build SimpleBlock element (ID + size + data)
    const simpleBlockElement: number[] = [];
    simpleBlockElement.push(0xa3); // SimpleBlock ID
    this.#writeVINT(simpleBlockElement, simpleBlock.length);
    simpleBlockElement.push(...simpleBlock);

    // Build Timecode element
    const timecodeValue: number[] = this.#encodeUnsignedInt(timestampMs);
    const timecodeElement: number[] = [];
    timecodeElement.push(0xe7); // Timecode ID
    this.#writeVINT(timecodeElement, timecodeValue.length);
    timecodeElement.push(...timecodeValue);

    // Calculate cluster content size
    const clusterContentSize: number = timecodeElement.length + simpleBlockElement.length;

    // Build complete cluster with known size
    const data: number[] = [];
    data.push(0x1f, 0x43, 0xb6, 0x75); // Cluster ID
    this.#writeVINT(data, clusterContentSize);
    data.push(...timecodeElement);
    data.push(...simpleBlockElement);

    return new Uint8Array(data);
  }

  #writeEBMLHeader(data: number[]): void {
    // EBML element
    data.push(0x1a, 0x45, 0xdf, 0xa3); // EBML ID

    const ebmlContent: number[] = [];
    this.#writeElement(ebmlContent, 0x4286, [0x01]); // EBMLVersion = 1
    this.#writeElement(ebmlContent, 0x42f7, [0x01]); // EBMLReadVersion = 1
    this.#writeElement(ebmlContent, 0x42f2, [0x04]); // EBMLMaxIDLength = 4
    this.#writeElement(ebmlContent, 0x42f3, [0x08]); // EBMLMaxSizeLength = 8
    this.#writeElement(ebmlContent, 0x4282, this.#stringToBytes('webm')); // DocType
    this.#writeElement(ebmlContent, 0x4287, [0x02]); // DocTypeVersion = 2
    this.#writeElement(ebmlContent, 0x4285, [0x02]); // DocTypeReadVersion = 2

    this.#writeVINT(data, ebmlContent.length);
    data.push(...ebmlContent);
  }

  #writeSegmentInfo(data: number[]): void {
    data.push(0x15, 0x49, 0xa9, 0x66); // Info ID

    const infoContent: number[] = [];
    this.#writeElement(infoContent, 0x2ad7b1, this.#encodeUnsignedInt(1000000)); // TimestampScale = 1000000 (1ms)
    this.#writeElement(infoContent, 0x4d80, this.#stringToBytes('WebCodecs Muxer')); // MuxingApp
    this.#writeElement(infoContent, 0x5741, this.#stringToBytes('WebCodecs Muxer')); // WritingApp

    this.#writeVINT(data, infoContent.length);
    data.push(...infoContent);
  }

  #writeTracks(data: number[]): void {
    data.push(0x16, 0x54, 0xae, 0x6b); // Tracks ID

    const tracksContent: number[] = [];

    if (this.#type === 'audio') {
      this.#writeAudioTrack(tracksContent);
    } else {
      this.#writeVideoTrack(tracksContent);
    }

    this.#writeVINT(data, tracksContent.length);
    data.push(...tracksContent);
  }

  #writeVideoTrack(tracksContent: number[]): void {
    tracksContent.push(0xae); // TrackEntry ID
    const trackContent: number[] = [];
    this.#writeElement(trackContent, 0xd7, [this.#videoTrackNumber]); // TrackNumber
    this.#writeElement(trackContent, 0x73c5, [this.#videoTrackNumber]); // TrackUID
    this.#writeElement(trackContent, 0x83, [0x01]); // TrackType = 1 (video)
    this.#writeElement(trackContent, 0x86, this.#stringToBytes('V_VP8')); // CodecID

    // Video settings
    trackContent.push(0xe0); // Video ID
    const videoContent: number[] = [];
    this.#writeElement(videoContent, 0xb0, this.#encodeUnsignedInt(this.#width)); // PixelWidth
    this.#writeElement(videoContent, 0xba, this.#encodeUnsignedInt(this.#height)); // PixelHeight
    this.#writeVINT(trackContent, videoContent.length);
    trackContent.push(...videoContent);

    this.#writeVINT(tracksContent, trackContent.length);
    tracksContent.push(...trackContent);
  }

  #writeAudioTrack(tracksContent: number[]): void {
    tracksContent.push(0xae); // TrackEntry ID
    const trackContent: number[] = [];
    this.#writeElement(trackContent, 0xd7, [this.#audioTrackNumber]); // TrackNumber
    this.#writeElement(trackContent, 0x73c5, [this.#audioTrackNumber]); // TrackUID
    this.#writeElement(trackContent, 0x83, [0x02]); // TrackType = 2 (audio)
    this.#writeElement(trackContent, 0x86, this.#stringToBytes('A_OPUS')); // CodecID

    // Audio settings
    trackContent.push(0xe1); // Audio ID
    const audioContent: number[] = [];
    const channels: number = 2;
    this.#writeElement(audioContent, 0xb5, this.#encodeFloat(this.#sampleRate)); // SamplingFrequency
    this.#writeElement(audioContent, 0x9f, [channels]);
    this.#writeVINT(trackContent, audioContent.length);
    trackContent.push(...audioContent);

    this.#writeVINT(tracksContent, trackContent.length);
    tracksContent.push(...trackContent);
  }

  #createSimpleBlock(
    trackNumber: number,
    frameData: Uint8Array,
    relativeTimestamp: number,
    isKeyframe: boolean
  ): number[] {
    const block: number[] = [];

    // Track number as VINT
    block.push(0x80 | trackNumber);

    // Relative timestamp (signed 16-bit, big-endian)
    const ts: number = Math.max(-32768, Math.min(32767, relativeTimestamp));
    block.push((ts >> 8) & 0xff);
    block.push(ts & 0xff);

    // Flags: keyframe (0x80) or not (0x00)
    block.push(isKeyframe ? 0x80 : 0x00);

    // Frame data
    for (const byte of frameData) {
      block.push(byte);
    }

    return block;
  }

  #encodeFloat(value: number): number[] {
    const buffer: ArrayBuffer = new ArrayBuffer(4);
    const view: DataView = new DataView(buffer);
    view.setFloat32(0, value, false); // Big-endian

    return [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)];
  }

  #writeElement(data: number[], id: number, value: number[]): void {
    // Write element ID
    if (id <= 0xff) {
      data.push(id);
    } else if (id <= 0xffff) {
      data.push((id >> 8) & 0xff);
      data.push(id & 0xff);
    } else if (id <= 0xffffff) {
      data.push((id >> 16) & 0xff);
      data.push((id >> 8) & 0xff);
      data.push(id & 0xff);
    } else {
      data.push((id >> 24) & 0xff);
      data.push((id >> 16) & 0xff);
      data.push((id >> 8) & 0xff);
      data.push(id & 0xff);
    }

    // Write size
    this.#writeVINT(data, value.length);

    // Write value
    data.push(...value);
  }

  #writeVINT(data: number[], value: number): void {
    if (value < 0x80 - 1) {
      data.push(0x80 | value);
    } else if (value < 0x4000 - 1) {
      data.push(0x40 | ((value >> 8) & 0x3f));
      data.push(value & 0xff);
    } else if (value < 0x200000 - 1) {
      data.push(0x20 | ((value >> 16) & 0x1f));
      data.push((value >> 8) & 0xff);
      data.push(value & 0xff);
    } else if (value < 0x10000000 - 1) {
      data.push(0x10 | ((value >> 24) & 0x0f));
      data.push((value >> 16) & 0xff);
      data.push((value >> 8) & 0xff);
      data.push(value & 0xff);
    } else {
      // 8-byte VINT for larger values
      data.push(0x01);
      for (let i: number = 6; i >= 0; i--) {
        data.push((value >> (i * 8)) & 0xff);
      }
    }
  }

  #encodeUnsignedInt(value: number): number[] {
    const bytes: number[] = [];
    if (value === 0) {
      bytes.push(0);
    } else {
      let v: number = value;
      while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      }
    }

    return bytes;
  }

  #stringToBytes(str: string): number[] {
    const bytes: number[] = [];
    for (let i: number = 0; i < str.length; i++) {
      bytes.push(str.charCodeAt(i));
    }

    return bytes;
  }
}

export default WebMMuxer;
