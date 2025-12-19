import IEvents from '@interfaces/IEvents';

type Callback = (evt: IEvents[keyof IEvents]) => void;

class Dispatcher {
  #listeners: Map<keyof IEvents, Set<Callback>> = new Map();

  emit<K extends keyof IEvents>(evtName: K, evt: IEvents[K]): void {
    const set: Set<Callback> | undefined = this.#listeners.get(evtName);
    if (!set) return;

    set.forEach((cb: Callback) => {
      cb(evt);
    });
  }

  on<K extends keyof IEvents>(evtName: K, callback: (evt: IEvents[K]) => void): void {
    const set: Set<Callback> = this.#listeners.get(evtName) ?? new Set<Callback>();
    set.add(callback as Callback);

    if (!this.#listeners.has(evtName)) {
      this.#listeners.set(evtName, set);
    }
  }

  off<K extends keyof IEvents>(evtName: K, callback: (evt: IEvents[K]) => void): void {
    const set: Set<Callback> | undefined = this.#listeners.get(evtName);
    if (!set) return;

    set.delete(callback as Callback);
    if (set.size === 0) {
      this.#listeners.delete(evtName);
    }
  }
}

export default Dispatcher;
