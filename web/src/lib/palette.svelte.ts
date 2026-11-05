import type { Overview, ProbeOutcome, Search, SearchOptions } from './protocol/client.ts';
import { analyze, interpret, type Analysis } from './search/analyze.ts';
import type { Detector } from './search/detect.ts';
import type { History } from './search/history.ts';
import type { Tier } from './search/plan.ts';
import { rank, type Hit, type Ranking } from './search/rank.ts';
import { tableKey } from './search/scope.ts';

const DEBOUNCE_MS = 150;
const TIERS: Tier[] = ['A', 'B', 'C'];

type Current = {
	generation: number;
	analysis: Analysis;
	outcomes: (ProbeOutcome | undefined)[];
	previous: Ranking | undefined;
};

type PaletteOptions = {
	overview: () => Overview | undefined;
	search: (options: SearchOptions) => Promise<Search>;
	reloadOverview: () => Promise<unknown>;
	history: History;
	timeZone?: string;
};

const toMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createPalette = ({
	overview,
	search,
	reloadOverview,
	history,
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: PaletteOptions) => {
	const palette = crypto.randomUUID();
	let input = $state('');
	let detector = $state<Detector | null>(null);
	let optIns = $state.raw<readonly string[]>([]);
	let insensitive = $state(false);
	let pastedLines = $state(false);
	let current = $state.raw<Current>();
	let generation = 0;
	let inflight = 0;
	let stale = false;
	let reloadedFor = -1;
	let jumpedFor = -1;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const interpretations = $derived.by(() => {
		const schema = overview();
		return schema ? interpret(input, schema).interpretations : [];
	});

	const ranking = $derived(
		current &&
			rank({
				plan: current.analysis.plan,
				outcomes: current.outcomes,
				hints: current.analysis.hints,
				history: history.score,
				query: current.analysis.query,
				searchPath: overview()?.searchPath ?? []
			})
	);

	const display = $derived(
		current &&
			(current.outcomes.length === 0 || current.outcomes.some((outcome) => outcome !== undefined)
				? ranking
				: current.previous)
	);

	const settle = (
		requested: number,
		positions: number[],
		results: ProbeOutcome[],
		fingerprint: string | null
	) => {
		if (requested !== generation || !current) return;
		inflight -= 1;
		const outcomes = [...current.outcomes];
		positions.forEach((position, index) => {
			outcomes[position] = results[index] ?? {
				type: 'failed',
				message: 'The connector returned fewer results than requested.'
			};
		});
		current = { ...current, outcomes };
		if (
			fingerprint !== null &&
			fingerprint !== overview()?.fingerprint &&
			reloadedFor !== requested
		) {
			reloadedFor = requested;
			void reloadOverview().then(() => {
				if (requested === generation) run();
			});
		}
	};

	const run = () => {
		clearTimeout(timer);
		stale = false;
		const schema = overview();
		if (!schema) return;
		const analysis = analyze(input, schema, detector, { optIns, insensitive, timeZone });
		const requested = ++generation;
		const { probes } = analysis.plan;
		current = {
			generation: requested,
			analysis,
			outcomes: probes.map(() => undefined),
			previous: display
		};
		const batches = TIERS.map((tier) =>
			probes.flatMap((probe, position) => (probe.tier === tier ? [position] : []))
		).filter((positions) => positions.length > 0);
		if (batches.length === 0 && analysis.normalized.value !== '') batches.push([]);
		inflight = batches.length;
		batches.forEach((positions, index) => {
			search({
				palette,
				generation: requested,
				fingerprint: index === 0,
				probes: positions.map((position) => probes[position].probe)
			})
				.then(({ results, fingerprint }) => settle(requested, positions, results, fingerprint))
				.catch((error: unknown) =>
					settle(
						requested,
						positions,
						positions.map(() => ({ type: 'failed', message: toMessage(error) })),
						null
					)
				);
		});
	};

	const cancel = () => {
		clearTimeout(timer);
		if (inflight === 0 || !current) return;
		inflight = 0;
		stale = true;
		const requested = ++generation;
		current = {
			...current,
			outcomes: current.outcomes.map((outcome) => outcome ?? { type: 'cancelled' })
		};
		search({ palette, generation: requested, probes: [] }).catch(() => undefined);
	};

	const reset = () => {
		detector = null;
		optIns = [];
		insensitive = false;
	};

	return {
		get input() {
			return input;
		},
		get detector() {
			return detector;
		},
		get interpretations() {
			return interpretations;
		},
		get analysis() {
			return current?.analysis;
		},
		get ranking() {
			return display;
		},
		get stale() {
			return display !== ranking;
		},
		get progress() {
			const total = current?.outcomes.length ?? 0;
			return total === 0 || !ranking ? 1 : 1 - ranking.pending / total;
		},
		get searching() {
			return ranking !== undefined && ranking.pending > 0;
		},
		get multiline() {
			return pastedLines || (current?.analysis.normalized.multiline ?? false);
		},
		setInput: (value: string, immediate = false, multiline = false) => {
			pastedLines = multiline;
			if (value === input) return;
			input = value;
			reset();
			cancel();
			if (immediate) run();
			else timer = setTimeout(run, DEBOUNCE_MS);
		},
		choose: (next: Detector | null) => {
			detector = next;
			cancel();
			run();
		},
		cycle: (step: 1 | -1) => {
			const detectors = interpretations.map((interpretation) => interpretation.detector);
			if (detectors.length === 0) return;
			const position = detector === null ? -1 : detectors.indexOf(detector);
			const next = (position + 1 + step + detectors.length + 1) % (detectors.length + 1);
			detector = next === 0 ? null : detectors[next - 1];
			cancel();
			run();
		},
		optIn: (tables: string[]) => {
			optIns = [...optIns, ...tables];
			cancel();
			run();
		},
		searchInsensitive: () => {
			insensitive = true;
			cancel();
			run();
		},
		retry: () => {
			cancel();
			run();
		},
		resume: () => {
			if (stale) run();
		},
		pause: cancel,
		takeJump: () => {
			const jump = ranking?.jump;
			if (!jump || !current || jumpedFor === current.generation) return undefined;
			jumpedFor = current.generation;
			return jump;
		},
		opened: (hit: Hit) => {
			const reason = hit.reasons[0];
			if (reason) history.record(tableKey(hit.table), reason.target.candidate.detector);
		}
	};
};

export type Palette = ReturnType<typeof createPalette>;
