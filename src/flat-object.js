import {ownKeys} from './utils';

const getDescriptor = Object.getOwnPropertyDescriptor;
const defProp = Object.defineProperty;

export default class FlatObject {

	constructor(obj, exclude = []) {
		const target = Object.create(obj);
		const ret = this.flatten(target, target, exclude);
		return ret;
	}

	flatten(obj, target, exclude) {
		const proto = Object.getPrototypeOf(obj);

		if (!proto) {
			return null;
		}

		const flattened = this.flatten(proto, target, exclude) || obj;
		let keys = ownKeys(flattened);
		obj = keys.filter(k => !exclude.includes(k)).reduce((o, k) => {
			const protoDescriptor = getDescriptor(flattened, k);
			const ownDescriptor = getDescriptor(o, k);
			if (!ownDescriptor) {
				defProp(target, k, protoDescriptor);
			}
			return o;
		}, obj);

		return obj;
	}
}
