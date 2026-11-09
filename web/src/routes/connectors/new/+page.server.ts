import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { resolve } from '$app/paths';
import { createConnector } from '#lib/server/connectors.ts';
import { connectorEnvironment } from '#lib/server/db/schema.ts';

const formSchema = z.object({
	name: z.string().trim().min(1),
	environment: z.enum(connectorEnvironment.enumValues)
});

export const load = ({ locals, url }) => {
	if (!locals.user) {
		redirect(303, `${resolve('/sign-in')}?${new URLSearchParams({ redirectTo: url.pathname })}`);
	}
};

export const actions = {
	default: async ({ locals, request }) => {
		if (!locals.user) redirect(303, resolve('/sign-in'));
		const form = formSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!form.success) return fail(400);
		return createConnector(locals.user.id, form.data.name, form.data.environment);
	}
};
