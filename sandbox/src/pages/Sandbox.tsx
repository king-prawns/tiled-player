import './Sandbox.css';
import React, {JSX} from 'react';

import {TiledPlayer} from '../../../src';

type IProps = Record<string, never>;
type IState = {
  status: string;
};

class Sandbox extends React.Component<IProps, IState> {
  #tiledPlayer: TiledPlayer;

  constructor(props: IProps) {
    super(props);

    this.#tiledPlayer = new TiledPlayer();

    this.state = {
      status: 'Idle'
    };
  }

  render(): JSX.Element {
    return (
      <div className="sandbox">
        <h1>Sandbox</h1>
        <button disabled={this.state.status !== 'Idle'} onClick={this.#handleLoad}>
          LOAD
        </button>
        <button disabled={this.state.status !== 'Running'} onClick={this.#handleDestroy}>
          DESTROY
        </button>
        <p>Status: {this.state.status}</p>
        <div className="video-container">
            <h3>Merged (MSE Video)</h3>
            <video id="tiled-player" width="640" height="480"></video>
        </div>
      </div>
    );
  }

  #handleLoad = async (): Promise<void> => {
    this.setState({status: 'Running'});
    await this.#tiledPlayer.load();
  };

  #handleDestroy = (): void => {
    this.#tiledPlayer.destroy();
    this.setState({status: 'Idle'});
  };
}

export default Sandbox;
