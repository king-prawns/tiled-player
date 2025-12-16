interface IEncodedAudioChunk {
  data: Uint8Array;
  timestamp: number;
  duration: number;
}

export default IEncodedAudioChunk;
