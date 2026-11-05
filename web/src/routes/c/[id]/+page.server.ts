import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { ownsConnector } from '#lib/server/connectors.ts';
import { relay } from '#lib/server/relay/index.ts';

export const load = async ({ params, locals, url }) => {
	if (!locals.user) {
		redirect(303, `${resolve('/sign-in')}?${new URLSearchParams({ redirectTo: url.pathname })}`);
	}
	if (!(await ownsConnector(locals.user.id, params.id))) error(404, 'Connector not found');
	return { prekey: relay.prekey(params.id) };
};
