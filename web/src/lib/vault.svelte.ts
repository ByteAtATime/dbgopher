import { z } from 'zod';
import {
	forgetAccountKey,
	fromHex,
	generateKey,
	loadAccountKey,
	saveAccountKey,
	toHex
} from './keys';
import { userKeyFromSeed } from './protocol/channel';
import { RelayError } from './protocol/client';
import {
	createVault,
	openContents,
	sealContents,
	unlockAccountKey,
	type Contents
} from './vault/crypto';
import { workerKdf } from './vault/kdf';
import { storedVaultSchema, type StoredVault, type VaultRecord } from './vault/record';

const MAX_CONFLICT_RETRIES = 3;

export type VaultState =
	| { type: 'loading' }
	| { type: 'missing' }
	| { type: 'locked'; stored: StoredVault }
	| { type: 'unlocked'; stored: StoredVault; accountKey: Uint8Array; contents: Contents }
	| { type: 'failed'; error: Error };

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const unexpected = (status: number) =>
	new RelayError('unexpected', `The relay responded with status ${status}.`);

const request = (init?: RequestInit) =>
	fetch('/v1/vault', init).catch(() => {
		throw new RelayError('unreachable', 'Could not reach the relay.');
	});

const fetchVault = async () => {
	const response = await request();
	if (response.status === 404) return undefined;
	if (!response.ok) throw unexpected(response.status);
	return storedVaultSchema.parse(await response.json());
};

const putVault = async (
	{ salt, kdfParams, encryptedAccountKey, encryptedContents }: VaultRecord,
	revision: number
) => {
	const response = await request({
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ salt, kdfParams, encryptedAccountKey, encryptedContents, revision })
	});
	if (response.status === 409) return undefined;
	if (!response.ok) throw unexpected(response.status);
	return z.object({ revision: z.int() }).parse(await response.json()).revision;
};

const pairingCredentials = async (
	userKey: string,
	enrollmentToken: string,
	pairingSecret: string
) => {
	const { publicKey } = await userKeyFromSeed(fromHex(userKey));
	return { pairingCode: `${enrollmentToken}.${pairingSecret}`, userKey: toHex(publicKey) };
};

export type PairingCredentials = Awaited<ReturnType<typeof pairingCredentials>>;

const createVaultStore = (userId: string) => {
	let state = $state.raw<VaultState>({ type: 'loading' });
	let loading: Promise<void> | undefined;

	const open = async (stored: StoredVault, accountKey: Uint8Array) => {
		const contents = await openContents(userId, accountKey, stored);
		saveAccountKey(userId, accountKey);
		state = { type: 'unlocked', stored, accountKey, contents };
	};

	const load = async () => {
		try {
			const stored = await fetchVault();
			if (!stored) {
				state = { type: 'missing' };
				return;
			}
			const remembered = loadAccountKey(userId);
			if (remembered) {
				try {
					await open(stored, remembered);
					return;
				} catch {
					forgetAccountKey(userId);
				}
			}
			state = { type: 'locked', stored };
		} catch (error) {
			state = { type: 'failed', error: toError(error) };
			loading = undefined;
		}
	};

	const setup = async (password: string) => {
		const { accountKey, contents, record } = await createVault(userId, password, workerKdf);
		const revision = await putVault(record, 0);
		if (revision === undefined) return load();
		saveAccountKey(userId, accountKey);
		state = { type: 'unlocked', stored: { ...record, revision }, accountKey, contents };
	};

	const unlock = async (password: string) => {
		if (state.type !== 'locked') return;
		const { stored } = state;
		await open(stored, await unlockAccountKey(userId, stored, password, workerKdf));
	};

	const write = async (change: (contents: Contents) => Contents) => {
		for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
			if (state.type !== 'unlocked') throw new Error('The vault is locked.');
			const { stored, accountKey, contents } = state;
			const next = change(contents);
			const record = { ...stored, encryptedContents: await sealContents(userId, accountKey, next) };
			const revision = await putVault(record, stored.revision);
			if (revision !== undefined) {
				state = { type: 'unlocked', stored: { ...record, revision }, accountKey, contents: next };
				return next;
			}
			const latest = await fetchVault();
			if (!latest) throw unexpected(404);
			await open(latest, accountKey);
		}
		throw unexpected(409);
	};

	const startPairing = async (connectorId: string, enrollmentToken: string) => {
		const pairingSecret = generateKey();
		const { userKey } = await write((contents) => ({
			...contents,
			connectors: {
				...contents.connectors,
				[connectorId]: { state: 'pairing', pairingSecret, enrollmentToken }
			}
		}));
		return pairingCredentials(userKey, enrollmentToken, pairingSecret);
	};

	const completePairing = (connectorId: string, identityKey: string) =>
		write((contents) => ({
			...contents,
			connectors: { ...contents.connectors, [connectorId]: { state: 'paired', identityKey } }
		}));

	const contents = () => (state.type === 'unlocked' ? state.contents : undefined);

	return {
		get state() {
			return state;
		},
		ensureLoaded: () => (loading ??= load()),
		setup,
		unlock,
		startPairing,
		storedPairingCredentials: (connectorId: string) => {
			const current = contents();
			const entry = current?.connectors[connectorId];
			if (!current || entry?.state !== 'pairing' || !entry.enrollmentToken) return undefined;
			return pairingCredentials(current.userKey, entry.enrollmentToken, entry.pairingSecret);
		},
		completePairing,
		connector: (connectorId: string) => contents()?.connectors[connectorId],
		connectors: () => Object.values(contents()?.connectors ?? {}),
		userKey: () => {
			const userKey = contents()?.userKey;
			return userKey === undefined ? undefined : fromHex(userKey);
		}
	};
};

export type VaultStore = ReturnType<typeof createVaultStore>;

let current: { userId: string; store: VaultStore } | undefined;

export const getVault = (userId: string) => {
	if (current?.userId !== userId) current = { userId, store: createVaultStore(userId) };
	return current.store;
};

export const forgetVault = (userId: string) => {
	forgetAccountKey(userId);
	if (current?.userId === userId) current = undefined;
};
