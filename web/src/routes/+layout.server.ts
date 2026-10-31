export const load = ({ locals }) => ({
	user: locals.user
		? { id: locals.user.id, name: locals.user.name, email: locals.user.email }
		: null
});
