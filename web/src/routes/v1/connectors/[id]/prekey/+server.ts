import { error } from '@sveltejs/kit';
import { ownsConnector } from '#lib/server/connectors.ts';
import { relay } from '#lib/server/relay/index.ts';

export const GET = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in to use this connector');
	if (!(await ownsConnector(locals.user.id, params.id))) error(404, 'Connector not found');

	const prekey = relay.prekey(params.id);
	if (!prekey) error(503, 'Connector is offline');
	return new Response(new Uint8Array(prekey), {
		headers: { 'content-type': 'application/octet-stream' }
	});
};
