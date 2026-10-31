import type { User, Session } from 'better-auth';
import type { Relay } from '#lib/server/relay/index.ts';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			user?: User;
			session?: Session;
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	var dbgopherRelay: Relay | undefined;
}

export {};
