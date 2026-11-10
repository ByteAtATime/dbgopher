import { error, json } from '@sveltejs/kit';
import { getEnrollment, renewEnrollment } from '#lib/server/connectors.ts';

export const GET = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in to use this connector');
	const enrollment = await getEnrollment(locals.user.id, params.id);
	if (!enrollment) error(404, 'Connector not found');
	const { identityKey, proof } = enrollment;
	return json(identityKey && proof ? { enrolled: true, identityKey, proof } : { enrolled: false });
};

export const POST = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Sign in to use this connector');
	const enrollmentToken = await renewEnrollment(locals.user.id, params.id);
	if (!enrollmentToken) error(409, 'Connector is already enrolled');
	return json({ enrollmentToken });
};
