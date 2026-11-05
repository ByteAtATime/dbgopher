import { z } from 'zod';
import type { Detector } from './detect';

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const SATURATION = 3;
const MAX_ENTRIES = 200;

const entrySchema = z.object({ weight: z.number(), at: z.number() });
const storeSchema = z.object({
	tables: z.record(z.string(), entrySchema),
	detectors: z.record(z.string(), entrySchema)
});

type Entry = z.output<typeof entrySchema>;
type Store = z.output<typeof storeSchema>;

const withStorage = <T>(action: (storage: Storage) => T) => {
	try {
		return action(localStorage);
	} catch {
		return undefined;
	}
};

const parse = (json: string | null | undefined): Store => {
	try {
		return storeSchema.parse(JSON.parse(json ?? ''));
	} catch {
		return { tables: {}, detectors: {} };
	}
};

const prune = (entries: Record<string, Entry>, decay: (entry: Entry) => number) =>
	Object.fromEntries(
		Object.entries(entries)
			.toSorted(([, a], [, b]) => decay(b) - decay(a))
			.slice(0, MAX_ENTRIES)
	);

export const createHistory = (storageKey: string, now: () => number = Date.now) => {
	let store = parse(withStorage((storage) => storage.getItem(storageKey)));

	const decay = (entry: Entry | undefined, time = now()) =>
		entry ? entry.weight * 0.5 ** ((time - entry.at) / HALF_LIFE_MS) : 0;

	const detectorKey = (table: string, detector: Detector) => `${detector}\0${table}`;

	const score = (table: string, detector: Detector) =>
		1 -
		Math.exp(
			-(decay(store.tables[table]) + decay(store.detectors[detectorKey(table, detector)])) /
				SATURATION
		);

	const record = (table: string, detector: Detector) => {
		const time = now();
		const bump = (entry: Entry | undefined) => ({ weight: decay(entry, time) + 1, at: time });
		const key = detectorKey(table, detector);
		store = {
			tables: prune({ ...store.tables, [table]: bump(store.tables[table]) }, (entry) =>
				decay(entry, time)
			),
			detectors: prune({ ...store.detectors, [key]: bump(store.detectors[key]) }, (entry) =>
				decay(entry, time)
			)
		};
		withStorage((storage) => storage.setItem(storageKey, JSON.stringify(store)));
	};

	return { score, record };
};

export type History = ReturnType<typeof createHistory>;
