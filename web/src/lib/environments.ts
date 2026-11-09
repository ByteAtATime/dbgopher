import type { connectorEnvironment } from './server/db/schema';

export type Environment = (typeof connectorEnvironment.enumValues)[number];

export const environments = {
	production: { label: 'Production', badge: 'bg-red-500/15 text-red-400', dot: 'bg-destructive' },
	staging: { label: 'Staging', badge: 'bg-amber-500/15 text-amber-400', dot: 'bg-warn' },
	development: {
		label: 'Development',
		badge: 'bg-muted text-muted-foreground',
		dot: 'bg-faint-foreground'
	}
} satisfies Record<Environment, { label: string; badge: string; dot: string }>;
