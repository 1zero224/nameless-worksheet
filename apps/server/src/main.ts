import { buildApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const app = await buildApp({
  config,
  enableJobs: true,
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: config.host });
