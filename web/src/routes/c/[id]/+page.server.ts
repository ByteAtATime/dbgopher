import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { getConnector } from '#lib/server/connectors.ts';
import { relay } from '#lib/server/relay/index.ts';

export const load = async ({ params, locals, url }) => {
	if (!locals.user) {
		redirect(303, `${resolve('/sign-in')}?${new URLSearchParams({ redirectTo: url.pathname })}`);
	}
	const connector = await getConnector(locals.user.id, params.id);
	if (!connector) error(404, 'Connector not found');
	return { connector, keyConfig: relay.keyConfig(params.id) };
};
