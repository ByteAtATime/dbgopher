import { error, json } from '@sveltejs/kit';
import { ownsConnector } from '#lib/server/connectors.ts';
import { MAX_SEALED_SIZE, relay } from '#lib/server/relay/index.ts';
import { Rejection_Reason } from '#lib/server/relay/relay_pb.ts';

export const POST = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Sign in to use this connector');
	if (!(await ownsConnector(locals.user.id, params.id))) error(404, 'Connector not found');

	const sealed = new Uint8Array(await request.arrayBuffer());
	if (sealed.length > MAX_SEALED_SIZE) error(413, 'Request is too large');

	const result = await relay.rpc(params.id, request.headers.get('x-session-id') ?? '', sealed);
	if (result.status === 'offline') error(503, 'Connector is offline');
	if (result.status === 'timeout') error(504, 'Connector did not respond in time');
	if (result.status === 'rejected') {
		return json({ rejection: Rejection_Reason[result.reason] }, { status: 422 });
	}
	return new Response(new Uint8Array(result.sealed), {
		headers: { 'content-type': 'application/octet-stream' }
	});
};
