import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { ownsConnector } from '#lib/server/connectors.ts';

export const load = async ({ params, locals, url }) => {
	if (!locals.user) {
		redirect(303, `${resolve('/sign-in')}?${new URLSearchParams({ redirectTo: url.pathname })}`);
	}
	if (!(await ownsConnector(locals.user.id, params.id))) error(404, 'Connector not found');
};
