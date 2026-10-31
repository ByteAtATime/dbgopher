const KEY_PATTERN = /^[0-9a-f]{64}$/i;

const storageKey = (userId: string) => `dbgopher:account-key:${userId}`;

const withStorage = <T>(action: (storage: Storage) => T) => {
	try {
		return action(localStorage);
	} catch {
		return undefined;
	}
};

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const parseKey = (hex: string) => {
	const trimmed = hex.trim();
	if (!KEY_PATTERN.test(trimmed)) return undefined;
	return Uint8Array.from({ length: 32 }, (_, index) =>
		parseInt(trimmed.slice(index * 2, index * 2 + 2), 16)
	);
};

export const loadAccountKey = (userId: string) =>
	parseKey(withStorage((storage) => storage.getItem(storageKey(userId))) ?? '');

export const saveAccountKey = (userId: string, key: Uint8Array) =>
	withStorage((storage) => storage.setItem(storageKey(userId), toHex(key)));

export const forgetAccountKey = (userId: string) =>
	withStorage((storage) => storage.removeItem(storageKey(userId)));

export const generateKey = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
