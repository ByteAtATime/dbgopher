import { error, json } from '@sveltejs/kit';
import { getVault, putVault } from '#lib/server/vault.ts';
import { vaultUpdateSchema } from '#lib/vault/record.ts';

export const GET = async ({ locals }) => {
	if (!locals.user) error(401, 'Sign in to use your vault');
	const stored = await getVault(locals.user.id);
	if (!stored) error(404, 'Vault not found');
	return json(stored);
};

export const PUT = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Sign in to use your vault');
	const update = vaultUpdateSchema.safeParse(await request.json().catch(() => undefined));
	if (!update.success) error(400, 'Malformed vault');
	const revision = await putVault(locals.user.id, update.data);
	if (revision === undefined) error(409, 'Vault has changed');
	return json({ revision });
};
