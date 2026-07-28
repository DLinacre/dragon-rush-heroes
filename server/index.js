'use strict';
/**
 * Application entrypoint.
 *
 * Boot sequence:
 *   1. Validate configuration (throws early on missing production secrets).
 *   2. Open the durable store and replay the write-ahead log.
 *   3. Construct services and wire the middleware pipeline + routes.
 *   4. Start background maintenance (session/battle housekeeping).
 *   5. Listen, and install graceful-shutdown handlers.
 */

const path = require('node:path');

const config = require('./config');
const logger = require('./core/logger');
const { Application } = require('./core/http');
const { createRepositories } = require('./data/repositories');
const { AuthService } = require('./services/authService');
const { GameService } = require('./services/gameService');
const { registerRoutes } = require('./routes');
const {
  securityHeaders, cors, rateLimit, sessionLoader, csrfProtection, limiter,
} = require('./middleware');

/**
 * Build the application without listening. Exposed for integration tests.
 * @returns {Promise<{app: Application, repos, authService, gameService, stop: Function}>}
 */
async function createApp() {
  const repos = await createRepositories();

  const authService = new AuthService(repos);
  await authService.warmup();
  const gameService = new GameService(repos);

  const app = new Application();

  // --- middleware pipeline (order matters) ---------------------------------
  app.use(securityHeaders());
  app.use(cors());
  app.use(rateLimit('global', config.rateLimit.globalPerMinute));
  app.use(sessionLoader(repos));
  app.use(csrfProtection());

  // --- API -----------------------------------------------------------------
  registerRoutes(app, { authService, gameService, repos });

  // --- static client (SPA) -------------------------------------------------
  app.static('/', config.paths.public, { spaFallback: 'index.html', immutable: true });

  // --- background maintenance ---------------------------------------------
  const maintenance = setInterval(async () => {
    try {
      await repos.transaction(() => {
        const sessions = repos.purgeDeadSessions();
        const battles = repos.purgeOldBattles();
        if (sessions || battles) logger.debug('Maintenance sweep', { sessions, battles });
      });
    } catch (err) {
      logger.error('Maintenance sweep failed', { err });
    }
  }, 15 * 60 * 1000);
  maintenance.unref?.();

  /** Release every resource held by the app. */
  const stop = async () => {
    clearInterval(maintenance);
    limiter.stop();
    await repos.store.close();
  };

  return { app, repos, authService, gameService, stop };
}

/** Boot and listen. */
async function main() {
  const { app, stop } = await createApp();
  const server = app.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });

  logger.info('Dragon Rush Heroes is airborne', {
    url: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`,
    env: config.env,
    pid: process.pid,
    node: process.version,
  });

  // --- graceful shutdown ----------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.server.shutdownGraceMs);
    force.unref?.();

    server.close(async () => {
      try {
        await stop();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', { err });
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crashed process must not silently keep serving traffic.
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { err: reason });
  });

  return server;
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal boot error', { err });
    process.exit(1);
  });
}

module.exports = { createApp, main };
