import type { ZxcvbnFactory } from '@zxcvbn-ts/core';

export const MIN_PASSWORD_SCORE = 3;
export const MAX_PASSWORD_SCORE = 4;

let factory: Promise<ZxcvbnFactory> | undefined;

const loadFactory = async () => {
	const [{ ZxcvbnFactory }, common, en] = await Promise.all([
		import('@zxcvbn-ts/core'),
		import('@zxcvbn-ts/language-common'),
		import('@zxcvbn-ts/language-en')
	]);
	return new ZxcvbnFactory({
		dictionary: { ...common.dictionary, ...en.dictionary },
		graphs: common.adjacencyGraphs
	});
};

export const loadPasswordScorer = async () => {
	const zxcvbn = await (factory ??= loadFactory());
	return (password: string) => zxcvbn.check(password).score;
};
