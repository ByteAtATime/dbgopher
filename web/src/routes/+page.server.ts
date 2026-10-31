import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { auth } from '#lib/server/auth.ts';
import { createConnector, listConnectors } from '#lib/server/connectors.ts';

export const load = async ({ locals }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null,
	connectors: locals.user ? await listConnectors(locals.user.id) : []
});

export const actions = {
	createConnector: async ({ locals }) => {
		if (!locals.user) redirect(303, resolve('/sign-in'));
		return createConnector(locals.user.id);
	},
	signOut: async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, resolve('/sign-in'));
	}
};
