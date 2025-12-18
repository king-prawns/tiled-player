import Player from '@player/player';

// DASH stream URLs
const DASH_URL_1: string = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const DASH_URL_2: string =
  'https://bitmovin-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd';

class TiledPlayer {
  #player: Player | null = null;

  load = async (): Promise<void> => {
    this.#player = new Player('tiled-player', 640, 480, 48000);
    await this.#player.init();

    await this.#player.load(DASH_URL_1, DASH_URL_2);

    this.#player.dispose();
  };

  destroy = (): void => {
    this.#player?.dispose();
  };
}

export default TiledPlayer;
