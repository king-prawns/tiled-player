import MSEPlayer from '@mse/MSEPlayer';

// DASH stream URLs
const DASH_URL_1: string = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const DASH_URL_2: string =
  'https://bitmovin-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd';

/**
 * TiledPlayer - Simple wrapper around MSEPlayer
 * MSEPlayer is the orchestrator that handles all DASH fetching, decoding, compositing, and encoding
 */
class TiledPlayer {
  #msePlayer: MSEPlayer | null = null;

  load = async (): Promise<void> => {
    this.#msePlayer = new MSEPlayer('tiled-player', 640, 480, 48000);
    await this.#msePlayer.init();

    await this.#msePlayer.load(DASH_URL_1, DASH_URL_2);

    this.#msePlayer.dispose();
  };

  destroy = (): void => {
    this.#msePlayer?.dispose();
  };
}

export default TiledPlayer;
