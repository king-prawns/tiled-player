interface IEncodedChunk {
  timestamp: number;
  key: boolean;
  data: Uint8Array;
}

export default IEncodedChunk;
