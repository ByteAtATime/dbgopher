import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { auth } from '#lib/server/auth.ts';
import { listConnectors } from '#lib/server/connectors.ts';
import { relay } from '#lib/server/relay/index.ts';

export const load = async ({ locals }) => ({
	connectors: locals.user
		? (await listConnectors(locals.user.id)).map((connector) => ({
				...connector,
				online: relay.isOnline(connector.id)
			}))
		: []
});

export const actions = {
	signOut: async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, resolve('/sign-in'));
	}
};
