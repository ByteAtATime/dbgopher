import { createServer } from 'node:http';
import { handler } from './build/handler.js';

const server = createServer(handler);

server.on('upgrade', (request, socket, head) => {
	if (!globalThis.dbgopherRelay?.handleUpgrade(request, socket, head)) socket.destroy();
});

server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');
