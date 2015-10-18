
const ownKeys = obj => Object.getOwnPropertyNames(obj).concat(Object.getOwnPropertySymbols(obj));
const getDescriptor = Object.getOwnPropertyDescriptor;
const noop = () => null;

export default class ObservableObject {

	on(event, handler) {
		this.handlers[event] = handler;
		return this;
	}

	emit(event, ...args) {
		return this.handlers[event].call(this.context, ...args);
	}

	createGetter(key, descriptor) {
		return () => {
			return this.emit('get', key, descriptor);
		};
	}

	createSetter(key, descriptor) {
		return (value) => {
			return this.emit('set', key, value, descriptor);
		};
	}

	defineObservable({key, descriptor}, target) {

		if (!this.isObservable(descriptor)) {
			return Object.defineProperty(target, key, descriptor);
		}

		const get = this.createGetter(key, descriptor);
		const set = this.createSetter(key, descriptor);
		return Object.defineProperty(target, key, {
			enumerable: descriptor.enumerable,
			get, set
		}, true);
	}

	isObservable({configurable}) {
		return configurable;
	}

	constructor(object) {
		this.context = object;

		ownKeys(object)
			.map(key => ({
				key,
				descriptor: getDescriptor(object, key)
			}))
			.forEach(prop => {
				this.defineObservable(prop, object);
			});
	}

	handlers = {
		get: noop,
		set: noop
	}
}
