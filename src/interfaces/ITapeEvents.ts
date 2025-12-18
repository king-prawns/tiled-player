import IEvents from './IEvents';

type ITapeEvents = {
  [key in keyof IEvents]: IEvents[key];
};

export default ITapeEvents;
