import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { auth } from '#lib/server/auth.ts';

export const load = ({ locals }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null
});

export const actions = {
	signOut: async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, resolve('/sign-in'));
	}
};
