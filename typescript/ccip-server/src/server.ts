import 'zod/compile';

import cors from '@fastify/cors';
import Fastify, { LogController } from 'fastify';
import { Registry } from 'prom-client';

import { startMetricsServer } from '@hyperlane-xyz/metrics/dist/server.js';
import { createServiceLogger } from '@hyperlane-xyz/utils';

import { getEnabledModules } from './config.js';
import { MAX_CCIP_PARAMETER_LENGTH } from './http.js';
import { moduleRegistry } from './moduleRegistry.js';
import { HealthService } from './services/HealthService.js';
import { registerRequestLogging, trustGceIngressProxy } from './utils/http.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
  initializeMetrics,
} from './utils/prometheus.js';
import { registerRateLimiting } from './utils/rateLimit.js';

async function startServer() {
  const VERSION = process.env.SERVICE_VERSION || 'dev';

  // Initialize logger first thing in startup
  const logger = await createServiceLogger({
    service: 'ccip-server',
    version: VERSION,
  });

  // Create metrics registry and initialize metrics
  const register = new Registry();
  initializeMetrics(register);

  const app = Fastify({
    bodyLimit: 10 * 1_024,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: MAX_CCIP_PARAMETER_LENGTH },
    loggerInstance: logger,
    requestTimeout: 300_000,
    trustProxy: trustGceIngressProxy,
  });
  await app.register(cors);
  registerRequestLogging(app);
  await registerRateLimiting(app);

  const enabledModules = getEnabledModules();
  if (enabledModules.length === 0) {
    logger.warn(
      '⚠️  No modules enabled. Set ENABLED_MODULES environment variable to mount services.',
    );
  }

  app.addHook('onResponse', async (request, reply) => {
    const path = request.raw.url?.split('?', 1)[0] ?? '';
    const moduleName = enabledModules.find(
      (name) => path === `/${name}` || path.startsWith(`/${name}/`),
    );
    if (moduleName) {
      // TODO: add a success label to the metric, once we properly distinguish unhandled errors from handled errors
      PrometheusMetrics.logLookupRequest(moduleName, reply.statusCode);
    }
  });

  // Dynamically mount only modules listed in the ENABLED_MODULES env var
  for (const name of enabledModules) {
    try {
      const ServiceClass = moduleRegistry[name];
      if (!ServiceClass) {
        logger.warn(
          {
            moduleName: name,
          },
          '⚠️  Module not found; skipping',
        );
        continue;
      }
      const service = await ServiceClass.create(name);
      service.registerRoutes(app, `/${name}`);

      logger.info(
        {
          moduleName: name,
        },
        '✅  Mounted module',
      );
    } catch (error) {
      logger.error(
        {
          moduleName: name,
          error,
          error_reason: UnhandledErrorReason.MODULE_INITIALIZATION_FAILED,
        },
        'Error initializing module',
      );
      PrometheusMetrics.logUnhandledError(
        name,
        UnhandledErrorReason.MODULE_INITIALIZATION_FAILED,
      );
      throw error;
    }
  }

  // Register Health Service
  const healthService = await HealthService.create('health');
  healthService.registerRoutes(app, '/health');

  // Log and handle undefined endpoints
  app.setNotFoundHandler(async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.raw.url,
      },
      'Undefined request',
    );
    return reply.code(404).send({ error: 'Endpoint not found' });
  });

  const port = parseInt(process.env.SERVER_PORT ?? '3000');
  await app.listen({ host: '0.0.0.0', port });
  logger.info(`Server listening on port ${port}`);

  return { app, logger, register };
}

// Start the server and handle startup logging
startServer()
  .then(({ app, logger, register }) => {
    logger.info('Server startup completed');
    const metricsServer = startMetricsServer(register, logger);
    logger.info('Prometheus metrics server started');

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await app.close();
      metricsServer.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('Server startup failed:', err); // Fallback to console if logger failed
    process.exit(1);
  });

/*
 * TODO: keep the process-level guard while Prisma can reject outside a request
 * lifecycle.
 * */
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err); // Fallback to console
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason); // Fallback to console
  process.exit(1);
});
