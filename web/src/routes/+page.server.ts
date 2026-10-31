import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { resolve } from '$app/paths';
import { auth } from '#lib/server/auth.ts';
import { createConnector, listConnectors } from '#lib/server/connectors.ts';

export const load = async ({ locals }) => ({
	connectors: locals.user ? await listConnectors(locals.user.id) : []
});

export const actions = {
	createConnector: async ({ locals, request }) => {
		if (!locals.user) redirect(303, resolve('/sign-in'));
		const name = z
			.string()
			.trim()
			.min(1)
			.safeParse((await request.formData()).get('name'));
		if (!name.success) return fail(400);
		return createConnector(locals.user.id, name.data);
	},
	signOut: async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, resolve('/sign-in'));
	}
};
