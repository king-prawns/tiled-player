import './Sandbox.css';
import React, {JSX} from 'react';

import {EEvent, IBufferUpdateEvent, IChangeSourceEvent, ITimeUpdateEvent, TiledPlayer} from '../../../src';

type IProps = Record<string, never>;
type IState = {
  status: string;
  videoBuffer: string;
  audioBuffer: string;
  activeSource: string;
  currentTime: string;
};

class Sandbox extends React.Component<IProps, IState> {
  #tiledPlayer: TiledPlayer;

  constructor(props: IProps) {
    super(props);

    this.#tiledPlayer = new TiledPlayer();

    this.state = {
      status: 'Idle',
      videoBuffer: '-',
      audioBuffer: '-',
      activeSource: 'source1',
      currentTime: '0.00'
    };
  }

  render(): JSX.Element {
    const {status, videoBuffer, audioBuffer, activeSource, currentTime} = this.state;

    return (
      <div className="sandbox">
        <h1>Sandbox</h1>
        <button disabled={status !== 'Idle'} onClick={this.#handleLoad}>
          LOAD
        </button>
        <button disabled={status !== 'Running'} onClick={this.#handleDestroy}>
          DESTROY
        </button>
        <p>Status: {status}</p>
        <div className="video-container">
          <h3>Merged (MSE Video)</h3>
          <video id="tiled-player" width="640" height="480"></video>
          <div className="buffer-info">
            <div className="info-row">
              <span className="label">Current Time:</span>
              <span className="value">{currentTime}s</span>
            </div>
            <div className="info-row">
              <span className="label">Active Source:</span>
              <span className="value highlight">{activeSource}</span>
            </div>
            <div className="info-row">
              <span className="label">Video Buffer:</span>
              <span className="value mono">{videoBuffer}</span>
            </div>
            <div className="info-row">
              <span className="label">Audio Buffer:</span>
              <span className="value mono">{audioBuffer}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  #handleLoad = async (): Promise<void> => {
    this.setState({status: 'Running'});

    this.#tiledPlayer?.on(EEvent.bufferUpdate, this.#onBufferUpdate);
    this.#tiledPlayer?.on(EEvent.changeSource, this.#onChangeSource);
    this.#tiledPlayer?.on(EEvent.timeUpdate, this.#onTimeUpdate);

    await this.#tiledPlayer.load();
  };

  #handleDestroy = (): void => {
    this.#tiledPlayer.destroy();

    this.#tiledPlayer?.off(EEvent.bufferUpdate, this.#onBufferUpdate);
    this.#tiledPlayer?.off(EEvent.changeSource, this.#onChangeSource);
    this.#tiledPlayer?.off(EEvent.timeUpdate, this.#onTimeUpdate);

    this.setState({
      status: 'Idle',
      videoBuffer: '-',
      audioBuffer: '-',
      activeSource: 'source1',
      currentTime: '0.00'
    });
  };

  #formatBufferRanges = (ranges: Array<number>): string => {
    if (ranges.length === 0) return '-';
    // ranges è [start1, end1, start2, end2, ...]
    const parts: Array<string> = [];
    for (let i: number = 0; i < ranges.length; i += 2) {
      parts.push(`[${ranges[i].toFixed(2)}, ${ranges[i + 1].toFixed(2)}]`);
    }

    return parts.join('');
  };

  #onBufferUpdate = (evt: IBufferUpdateEvent): void => {
    this.setState({
      videoBuffer: this.#formatBufferRanges(evt.video),
      audioBuffer: this.#formatBufferRanges(evt.audio)
    });
  };

  #onChangeSource = (evt: IChangeSourceEvent): void => {
    this.setState({activeSource: evt.source});
  };

  #onTimeUpdate = (evt: ITimeUpdateEvent): void => {
    this.setState({currentTime: evt.currentTime.toFixed(2)});
  };
}

export default Sandbox;
