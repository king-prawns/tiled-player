// import Decoder from '@decoder/decoder';
import Encoder from '@encoder/encoder';
// import generateCamera from '@generator/camera';
// import generateMerge, {MergeOptions} from '@generator/merge';
import generateMergeDash, {AudioSourceId, MergeDashOptions} from '@generator/mergeDash';
// import generateVideo from '@generator/video';
import IEncodedChunk from '@interfaces/IEncodedChunk';
import MSEPlayer from '@mse/MSEPlayer';

class TiledPlayer {
  #abortController: AbortController | null = null;
  #msePlayer: MSEPlayer | null = null;

  load = async (): Promise<void> => {
    this.#abortController = new AbortController();

    // Initialize MSE player for merged output (video + audio)
    this.#msePlayer = new MSEPlayer('tiled-player', 640, 480, 48000);
    await this.#msePlayer.init();

    // Run merge pipeline
    await this.#runMergePipeline();

    this.#msePlayer.dispose();
  };

  destroy = (): void => {
    this.#abortController?.abort();
    this.#msePlayer?.dispose();
  };

  /**
   * Merge pipeline: composites two DASH streams and sends to MSE player
   */
  #runMergePipeline = async (): Promise<void> => {
    const videoEncoder: Encoder = new Encoder();
    await videoEncoder.init();

    // Send encoded video chunks to MSE player
    videoEncoder.onChunk((chunk: IEncodedChunk) => {
      this.#msePlayer?.appendVideoChunk(chunk);
    });

    // Options for merge generator
    const mergeOptions: MergeDashOptions = {
      signal: this.#abortController?.signal,
      onSwap: (swapped: boolean) => {
        // When swapped: dash2 is background (active), dash1 is PiP
        // When not swapped: dash1 is background (active), dash2 is PiP
        const activeSource: AudioSourceId = swapped ? 'dash2' : 'dash1';
        this.#msePlayer?.setActiveAudioSource(activeSource);
        // eslint-disable-next-line no-console
        console.log(`[WebCodecs] Audio switched to ${activeSource}`);
      },
      onAudioChunk: (chunk: IEncodedChunk, sourceId: AudioSourceId) => {
        this.#msePlayer?.appendAudioChunk(chunk, sourceId);
      }
    };

    // Encode all frames from merge generator
    for await (const videoFrame of generateMergeDash(mergeOptions)) {
      videoEncoder.encode(videoFrame);
    }

    await videoEncoder.flush();
  };
}

export default TiledPlayer;
