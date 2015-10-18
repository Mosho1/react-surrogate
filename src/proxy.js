import {cloneInto, ownKeys, getProp} from './utils';
import ObservableObject from './observable-object';
import FlatObject from './flat-object';
import {controlledObject, deleteFromControlledOnbject} from './controlled-object';
import EE from 'tiny-emitter';

const noop = x => x;
const getDescriptor = Object.getOwnPropertyDescriptor;

const objectProtoKeys = ownKeys(Object.getPrototypeOf({}));
const functionProtoKeys = ownKeys(Object.getPrototypeOf(function() {}));
const internals = ['_reactInternalInstance', '__reactAutoBindMap', 'refs'];

const propCache = Symbol('propCache');
const constructor = Symbol('constructor');
const reactProxy = '__reactProxy';
const originalFn = '__originalFn';

const defProp = Object.defineProperty;

const isReactProxy = obj =>
	obj && obj.hasOwnProperty(reactProxy);

if (!Object.defineProperty.hijacked) {
	// listen to properties defined using Object.defineProperty at runtime. Pretty hacky
	Object.defineProperty = (...args) => {
		if (isReactProxy(...args)) {
			Object.emitter.emit('Object.defineProperty', args);
		}
		return defProp(...args);
	};
}

Object.emitter = new EE();
Object.defineProperty.hijacked = true;

// save a reference to the unbound function
const protoBind = Function.prototype.bind;
Function.prototype.bind = function(...args) {
	const bound = protoBind.apply(this, args);
	defProp(bound, originalFn, {value: this});
	return bound;
};

const defineProxyProp = (obj, desc) => defProp(obj, reactProxy, desc || {value: true});

export class Proxy {
	constructor(Component) {
		this[constructor] = Component;
		this.proxied = (props) => {
			const instance = this.updateInstance({props});
			instance[propCache].proxyConstructor = this.proxied;
			Object.setPrototypeOf(instance, this.proxied.prototype);
			return instance;
		};

		// derived classes share instances cache
		this.proxied.prototype.instances = this.instances = Component.prototype.instances || new Set();

		// and a cache of all classes in the prototype chain
		this.proxied.prototypeSet = this.prototypeSet = Component.prototypeSet || new Set();

		this.prototypeSet.add(this);

		this.wrapLifestyleMethods(this.proxied.prototype);

		// this holds metadata about properties
		this[propCache] = {};

		// legacy react type property
		this.proxied.type = this.proxied;

		// set up the initial proxied constructor
		this.updateConstructor(Component);

		defineProxyProp(this.proxied, {value: this});

		// detect relevant Object.defineProperty calls and set a dirty flag
		Object.emitter.on('Object.defineProperty', ([context, key, descriptor, noCache]) => {
			if (context === this.proxied && !noCache) {
				this[propCache][key] = {dirty: true};
			}
		});
	}

	// adds `componentWillMount` and `componentWillUnmount` lifecycle methods
	// (wrapping old ones if they exist). These methods will add/remove instances
	// from a cache of all instances, that exists on the Proxy instance.
	wrapLifestyleMethods(component) {
		const {instances} = this;

		const componentWillMount = component.componentWillMount || noop;
		const componentWillUnmount = component.componentWillUnmount || noop;

		if (component.componentWillMount && component.componentWillMount[reactProxy] === true) {
			return;
		}

		Object.assign(component, {
			componentWillMount() {
				componentWillMount.call(this);
				instances.add(this);
			},
			componentWillUnmount() {
				componentWillUnmount.call(this);
				instances.delete(this);
			}
		});

		component.componentWillMount.toString = componentWillMount.toString.bind(componentWillMount);
		component.componentWillUnmount.toString = componentWillUnmount.toString.bind(componentWillUnmount);

		component.componentWillMount[reactProxy] = true;
	}

	update(Component) {

		// update constructor
		const instances = this.updateConstructor(Component);

		// update all constructors in the prototype chain
		this.prototypeSet.forEach(p => {
			if (p !== this) {
				p.updateConstructor();
			}
		});

		// go over and update instances
		instances.forEach(instance => {
			// all inherited classes share the instances. we go over all of them each time any
			// of the classes are updated, but only update instances using their current constructor
			// if it wasn't the one directly replaced, rather one of the classes it extends
			// was.
			const proxyConstructor = getProp(instance, [propCache, 'proxyConstructor']);
			const updateComponent = !proxyConstructor || (proxyConstructor === this.proxied)
				? Component
				: proxyConstructor;
			this.updateInstance(instance, updateComponent);
		});

		return instances;
	}

	updateConstructor(Component = this[constructor]) {

		// update prototype
		const exclude = objectProtoKeys.concat(functionProtoKeys.filter(s => s !== 'name'));
		cloneInto(this.proxied.prototype, new FlatObject(Component.prototype, exclude), {
			exclude: ['instances']
		});

		// update statics
		const flatComponent = new FlatObject(Component, exclude);
		cloneInto(this.proxied, flatComponent, {
			exclude: ['type', 'prototypeSet', propCache, reactProxy],
			shouldDefine: (k, target) => {
				const cached = this[propCache][k];
				const isProxy = target.hasOwnProperty(reactProxy);
				if (isProxy && cached && cached.dirty) {
					return false;
				}
			},
			shouldDelete: (k, target) => {
				const cached = this[propCache][k];
				if (!cached || (cached && cached.dirty)) {
					return false;
				}
			}
		});

		const oldCache = this[propCache];

		// static property cache
		let cache = ownKeys(this.proxied)
			.reduce((acc, k) => {
				acc[k] = {
					dirty: oldCache[k] && oldCache[k].dirty
				};

				const descriptor = getDescriptor(this.proxied, k);
				acc[k].value = descriptor.value;
				acc[k].get = descriptor.get && descriptor.get.bind(this.proxied);
				return acc;
			}, {});

		this[propCache] = cache;
		this[constructor] = Component;
		const observableObject = new ObservableObject(this.proxied);

		const get = key => {
			const {value, get: getter} = cache[key];
			return !value && typeof getter === 'function'
				? getter()
				: value;
		};

		const set = function(key, value, descriptor) {
			let oldSet = descriptor.set;
			let doSet = oldSet
					? function(v) {
						cache[key].value = oldSet.call(this, v);
					}
					: function(v) {
						const origFn = v[originalFn];
						const oldValue = cache[key].value;
						const newValue = origFn
								? v[originalFn]
								: v;
						cache[key].dirty = newValue !== oldValue;
						cache[key].value = newValue;
					};
			doSet.call(this, value);
		};

		observableObject
			.on('get', get)
			.on('set', set);

		this.wrapLifestyleMethods(this.proxied.prototype);

		this.proxied.prototype.constructor = this.proxied;
		this.proxied.prototype.constructor.toString = Component.toString.bind(Component);

		return [...this.instances];
	}

	updateInstance(instance = {}, Component = this[constructor]) {

		// initialize a new instance using the replacing component, including calling `componentWillMount`
		const newInstance = new Component(instance.props);

		if (newInstance.componentWillMount && !newInstance.componentWillMount.hasOwnProperty(reactProxy)) {
			newInstance.componentWillMount();
		}

		const exclude = objectProtoKeys;
		const flattened = new FlatObject(newInstance, exclude);

		this.wrapLifestyleMethods(flattened);

		flattened.state = instance.state || flattened.state || {};
		flattened.props = instance.props || flattened.props || {};
		flattened.context = instance.context || flattened.context || {};

		if (!instance.hasOwnProperty(propCache)) {
			defProp(instance, propCache, {
				value: {}
			});
		}

		controlledObject(flattened, instance, instance[propCache]);

		// for instance-descriptor tests, don't delete properties which aren't on the prototype of the Component.
		// warning: I currently have no idea what this does and why it makes things work
		const namesToExclude = Object.keys(instance).filter(k => {
			const {get, set} = getDescriptor(instance, k);
			const hasProxySymbol = [get, set].some(x => getProp(x, reactProxy));
			return !hasProxySymbol;
		});

		const instanceProtoKeys = ownKeys(Object.getPrototypeOf(instance));
		const newProtoKeys = ownKeys(Component.prototype);
		const oldProtoKeys = ownKeys(this[constructor].prototype);

		namesToExclude.push(...instanceProtoKeys.filter(k =>
			!newProtoKeys.includes(k) && !oldProtoKeys.includes(k)));

		cloneInto(instance, flattened, {
			exclude: internals.concat(namesToExclude),
			noDelete: true,
			onDelete(k, target) {
				deleteFromControlledOnbject(target, k, target[propCache]);
			}
		});

		return instance;
	}

	get() {
		return this.proxied;
	}

}

export const createProxy = Component => {
	if (Component.hasOwnProperty(reactProxy)) {
		return Component[reactProxy];
	}
	return new Proxy(Component);
};

export const updateProxy = (proxy, NewComponent) => {
	proxy.update(NewComponent);
	proxy.instances.forEach(instance => {
		instance.forceUpdate();
	});
	return proxy;
};
