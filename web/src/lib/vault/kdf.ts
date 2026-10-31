import { z } from 'zod';
import type { KdfParams } from './record';

export type Kdf = (password: string, salt: Uint8Array, params: KdfParams) => Promise<Uint8Array>;

export const workerKdf: Kdf = (password, salt, params) =>
	new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<unknown>) => {
			worker.terminate();
			resolve(z.instanceof(Uint8Array).parse(event.data));
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message));
		};
		worker.postMessage({ password, salt, params });
	});
