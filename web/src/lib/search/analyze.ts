import type { Overview } from '../protocol/client';
import { detect, select, type Detector, type Hint } from './detect';
import { normalize } from './normalize';
import { plan, type PlanOptions } from './plan';
import { hintedTables, parseScope } from './scope';

export const interpret = (input: string, overview: Overview) => {
	const normalized = normalize(input);
	const scope = parseScope(normalized.value, overview.tables);
	const raw = scope.hint ? scope.query : normalized.raw;
	const interpretations = detect(scope.query, raw, scope.hint !== undefined);
	return { normalized, query: scope.query, hint: scope.hint, interpretations };
};

export const analyze = (
	input: string,
	overview: Overview,
	detector: Detector | null,
	options: PlanOptions
) => {
	const interpreted = interpret(input, overview);
	const selected = select(interpreted.interpretations, detector);
	const hints: Hint[] = [...(interpreted.hint ? [interpreted.hint] : []), ...selected.hints];
	return {
		...interpreted,
		hints: hintedTables(hints, overview.tables),
		plan: plan(overview, selected.candidates, options)
	};
};

export type Analysis = ReturnType<typeof analyze>;
