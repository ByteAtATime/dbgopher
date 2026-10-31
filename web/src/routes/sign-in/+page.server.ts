import { error, redirect } from '@sveltejs/kit';
import { auth } from '#lib/server/auth.ts';

const redirectTarget = (url: URL) => {
	const target = new URL(url.searchParams.get('redirectTo') ?? '/', url);
	return target.origin === url.origin ? `${target.pathname}${target.search}` : '/';
};

export const load = ({ locals, url }) => {
	if (locals.user) redirect(303, redirectTarget(url));
};

export const actions = {
	default: async ({ url }) => {
		const result = await auth.api.signInSocial({
			body: { provider: 'google', callbackURL: redirectTarget(url) }
		});
		if (!result.url) error(502, 'Google sign-in is unavailable');
		redirect(303, result.url, { external: ['https://accounts.google.com'] });
	}
};
