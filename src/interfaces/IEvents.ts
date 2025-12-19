import EEvent from '@enum/EEvent';

import IBufferUpdateEvent from './IBufferUpdateEvent';
import IChangeSourceEvent from './IChangeSourceEvent';
import ITimeUpdateEvent from './ITimeUpdateEvent';

interface IEvents {
  [EEvent.bufferUpdate]: IBufferUpdateEvent;
  [EEvent.changeSource]: IChangeSourceEvent;
  [EEvent.timeUpdate]: ITimeUpdateEvent;
}

export default IEvents;
