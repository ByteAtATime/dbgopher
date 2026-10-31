import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { connector, user } from '../src/lib/server/db/schema.ts';
import { hashToken } from '../src/lib/server/tokens.ts';

const { DATABASE_URL, ORIGIN = 'http://localhost:5173' } = process.env;
const email = process.argv[2];
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!email) throw new Error('Usage: pnpm connector:create <email of the owner>');

const client = postgres(DATABASE_URL);
const db = drizzle(client);
const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
if (!owner) {
	await client.end();
	throw new Error(`No user with the email ${email}. Sign in once before creating a connector.`);
}
const token = randomBytes(32).toString('base64url');
const key = randomBytes(32).toString('hex');
const [{ id }] = await db
	.insert(connector)
	.values({ userId: owner.id, tokenHash: hashToken(token) })
	.returning({ id: connector.id });
await client.end();

const relayUrl = new URL('/connector', ORIGIN);
relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';

console.log(`Start the connector with:

  RELAY_URL=${relayUrl} CONNECTOR_ID=${id} CONNECTOR_TOKEN=${token} CONNECTOR_KEY=${key} DATABASE_URL=<database url> cargo run --manifest-path ../connector/Cargo.toml

Then open ${new URL(`/c/${id}#key=${key}`, ORIGIN)}`);
