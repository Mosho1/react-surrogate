const originalFn = '__originalFn';
const reactProxy = '__reactProxy';

const noop = x => x;
const defProp = Object.defineProperty;
const getDescriptor = Object.getOwnPropertyDescriptor;
const defineProxyProp = (obj, desc) => defProp(obj, reactProxy, desc || {value: true});

import {ownKeys, getProp} from './utils';

const propDefaults = {
	enumerable: true,
	configurable: true,
	writable: true
};

export const controlledObject = (object, executionContext, cache) => {

	ownKeys(object).forEach(k => {
		const cachedProp = cache[k] = cache[k] || {};
		cachedProp.prop = getDescriptor(object, k);

		if (!cachedProp.prop.configurable) {
			return;
		}

		cachedProp.context = executionContext;
		cachedProp.value = getProp(cachedProp.prop.value, originalFn, cachedProp.prop.value);
		cachedProp.wasSet = false;

		cachedProp.getter = cachedProp.getter || function() {

			if (!cachedProp.prop.value && cachedProp.prop.get) {
				const desc = getDescriptor(this, k);
				const {get} = cachedProp.prop;
				const got = get && get.call(this);
				cachedProp.value = getProp(got, originalFn, got);
				defProp(this, k, desc);
			}

			if (typeof cachedProp.value === 'function') {
				if (!cachedProp.bound) {

					cachedProp.bound = (...args) =>
						cachedProp.value.apply(cachedProp.context, args);

					defineProxyProp(cachedProp.bound);

					cachedProp.bound.bind = (...args) => {
						return cachedProp.bound;
					};
				}
				return cachedProp.bound;
			}
			return cachedProp.value;
		};

		cachedProp.setter = cachedProp.setter || function(v) {
			const {set} = cachedProp.prop;
			cachedProp.wasSet = true;
			if (cachedProp.bound === v) {
				return;
			}

			cachedProp.value = set
				? set.call(this, v)
				: v;
		};

		defineProxyProp(cachedProp.getter);
		defineProxyProp(cachedProp.setter);
		defProp(object, k, {
			configurable: true,
			enumerable: true,
			get: cachedProp.getter,
			set: cachedProp.setter
		});

	});
};

export const deleteFromControlledOnbject = (controlled, k, cache) => {
	const prop = cache[k];
	if (prop && prop.bound) {
		prop.bound.call = noop;
		prop.bound.apply = noop;
	}
	defProp(controlled, k, {
		enumerable: true,
		get() {
			if (prop && prop.wasSet) {
				return noop;
			}
		},
		set(value) {
			defProp(this, k, {value, ...propDefaults});
		}
	});
};
