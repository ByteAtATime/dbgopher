import { z } from 'zod';
import { deriveWrappingKey } from './argon2';
import { kdfParamsSchema } from './record';

const requestSchema = z.object({
	password: z.string(),
	salt: z.instanceof(Uint8Array),
	params: kdfParamsSchema
});

self.onmessage = async (event: MessageEvent<unknown>) => {
	const { password, salt, params } = requestSchema.parse(event.data);
	const key = await deriveWrappingKey(password, salt, params);
	self.postMessage(key, { transfer: [key.buffer] });
};
