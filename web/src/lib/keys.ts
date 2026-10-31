const KEY_PATTERN = /^[0-9a-f]{64}$/i;

const storageKey = (connectorId: string) => `dbgopher:key:${connectorId}`;

const withStorage = <T>(action: (storage: Storage) => T) => {
	try {
		return action(sessionStorage);
	} catch {
		return undefined;
	}
};

export const parseKey = (hex: string) => {
	const trimmed = hex.trim();
	if (!KEY_PATTERN.test(trimmed)) return undefined;
	return Uint8Array.from({ length: 32 }, (_, index) =>
		parseInt(trimmed.slice(index * 2, index * 2 + 2), 16)
	);
};

export const loadKey = (connectorId: string) =>
	parseKey(withStorage((storage) => storage.getItem(storageKey(connectorId))) ?? '');

export const saveKey = (connectorId: string, hex: string) =>
	withStorage((storage) => storage.setItem(storageKey(connectorId), hex.trim()));

export const forgetKey = (connectorId: string) =>
	withStorage((storage) => storage.removeItem(storageKey(connectorId)));
