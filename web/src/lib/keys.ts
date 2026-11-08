const KEY_PATTERN = /^[0-9a-f]{64}$/i;

const storageKey = (userId: string) => `dbgopher:account-key:${userId}`;

const withStorage = <T>(action: (storage: Storage) => T) => {
	try {
		return action(localStorage);
	} catch {
		return undefined;
	}
};

export const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string) =>
	Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));

export const parseKey = (hex: string) => {
	const trimmed = hex.trim();
	return KEY_PATTERN.test(trimmed) ? fromHex(trimmed) : undefined;
};

export const loadAccountKey = (userId: string) =>
	parseKey(withStorage((storage) => storage.getItem(storageKey(userId))) ?? '');

export const saveAccountKey = (userId: string, key: Uint8Array) =>
	withStorage((storage) => storage.setItem(storageKey(userId), toHex(key)));

export const forgetAccountKey = (userId: string) =>
	withStorage((storage) => storage.removeItem(storageKey(userId)));

export const generateKey = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
