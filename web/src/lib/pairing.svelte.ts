import { z } from 'zod';
import { parseKey } from './keys';
import { verifyPairingProof } from './protocol/channel';
import type { VaultStore } from './vault.svelte';

const POLL_INTERVAL_MS = 2_000;

const enrollmentSchema = z.discriminatedUnion('enrolled', [
	z.object({ enrolled: z.literal(false) }),
	z.object({ enrolled: z.literal(true), identityKey: z.string(), proof: z.string() })
]);

export type PairingStatus = 'waiting' | 'paired' | 'failed';

const fetchEnrollment = async (connectorId: string) => {
	const response = await fetch(`/v1/connectors/${encodeURIComponent(connectorId)}/enrollment`);
	if (!response.ok) return undefined;
	return enrollmentSchema.parse(await response.json());
};

export const confirmPairing = async (
	vault: VaultStore,
	connectorId: string
): Promise<PairingStatus> => {
	const entry = vault.connector(connectorId);
	if (entry?.state !== 'pairing') return entry ? 'paired' : 'failed';
	const enrollment = await fetchEnrollment(connectorId);
	if (!enrollment?.enrolled) return 'waiting';
	const identityKey = parseKey(enrollment.identityKey);
	const proof = parseKey(enrollment.proof);
	const pairingSecret = parseKey(entry.pairingSecret);
	if (
		!identityKey ||
		!proof ||
		!pairingSecret ||
		!(await verifyPairingProof(pairingSecret, connectorId, identityKey, proof))
	)
		return 'failed';
	await vault.completePairing(connectorId, enrollment.identityKey);
	return 'paired';
};

export const createPairing = (vault: VaultStore, connectorId: string) => {
	let status = $state<PairingStatus>('waiting');

	const start = () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;

		const poll = async () => {
			const next = await confirmPairing(vault, connectorId).catch((): PairingStatus => 'waiting');
			if (stopped) return;
			status = next;
			if (next === 'waiting') timer = setTimeout(poll, POLL_INTERVAL_MS);
		};

		void poll();

		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	};

	return {
		get status() {
			return status;
		},
		start
	};
};
