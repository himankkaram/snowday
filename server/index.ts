import 'dotenv/config';
import { createGameServer, DEFAULT_STATIC_DIR } from './app.js';
import { log } from './logger.js';

const port = Number(process.env.PORT ?? 3000);
const hostKey = process.env.HOST_KEY ?? '';

if (!hostKey || hostKey === 'change-me-before-the-event') {
  log.warn('HOST_KEY is unset or still the example value. Set it in .env before the demo.');
}

const server = createGameServer({ hostKey: hostKey || 'dev', staticDir: DEFAULT_STATIC_DIR });

// A crash in one handler should not take the whole game down mid-demo.
process.on('uncaughtException', (err) => log.error('uncaught exception', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

const actual = await server.listen(port);
log.info(`game server on http://localhost:${actual}  (health: /health)`);

const shutdown = async () => {
  log.info('shutting down');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
