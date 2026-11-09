export class EventEmitter {
    _listeners = new Map();
    on(event, listener) {
        const list = this._listeners.get(event) ?? [];
        list.push(listener);
        this._listeners.set(event, list);
        return this;
    }
    off(event, listener) {
        const list = this._listeners.get(event) ?? [];
        this._listeners.set(event, list.filter(l => l !== listener));
        return this;
    }
    emit(event, ...args) {
        const list = this._listeners.get(event) ?? [];
        for (const listener of list)
            listener(...args);
    }
}
//# sourceMappingURL=events.js.map