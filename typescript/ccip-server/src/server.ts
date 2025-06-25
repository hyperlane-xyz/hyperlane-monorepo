import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';

import { createServiceLogger } from '@hyperlane-xyz/utils';

import packageJson from '../package.json' with { type: 'json' };

import { getEnabledModules } from './config.js';
import { ServiceFactory } from './services/BaseService.js';
import { CCTPService } from './services/CCTPService.js';
import { CallCommitmentsService } from './services/CallCommitmentsService.js';
import { HealthService } from './services/HealthService.js';
import { OPStackService } from './services/OPStackService.js';
import {
  PrometheusMetrics,
  startPrometheusServer,
} from './utils/prometheus.js';

export const moduleRegistry: Record<string, ServiceFactory> = {
  callCommitments: CallCommitmentsService,
  cctp: CCTPService,
  opstack: OPStackService,
};

async function startServer() {
  // Initialize logger first thing in startup
  const logger = await createServiceLogger({
    service: 'ccip-server',
    version: packageJson.version,
  });

  const app = express();
  app.use(cors());
  app.use(express.json() as express.RequestHandler);
  app.use(pinoHttp({ logger }));

  if (getEnabledModules().length === 0) {
    logger.warn(
      '⚠️  No modules enabled. Set ENABLED_MODULES environment variable to mount services.',
    );
  }

  // Dynamically mount only modules listed in the ENABLED_MODULES env var
  for (const name of getEnabledModules()) {
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
      const service = await ServiceClass.create({
        logger,
        namespace: name,
      });

      app.use(`/${name}`, (req, res, next) => {
        res.on('finish', () => {
          // TODO: add a success label to the metric, once we properly distinguish unhandled errors from handled errors
          PrometheusMetrics.logLookupRequest(name, res.statusCode);
        });
        next();
      });
      app.use(`/${name}`, service.router);

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
        },
        'Error initializing module',
      );
      PrometheusMetrics.logUnhandledError();
      throw error;
    }
  }

  // Register Health Service
  const healthService = await HealthService.create({ logger });
  app.use(`/health`, healthService.router);

  // Log and handle undefined endpoints
  app.use((req, res) => {
    req.log.info(
      {
        method: req.method,
        url: req.originalUrl,
      },
      'Undefined request',
    );
    res.status(404).json({ error: 'Endpoint not found' });
  });

  const port = parseInt(process.env.SERVER_PORT ?? '3000');
  app.listen(port, () => logger.info(`Server listening on port ${port}`));

  return logger; // Return logger for error handlers
}

// Start the server and handle startup logging
startServer()
  .then((logger) => logger.info('Server startup completed'))
  .catch((err) => {
    console.error('Server startup failed:', err); // Fallback to console if logger failed
    process.exit(1);
  });

startPrometheusServer()
  .then(() => console.log('Prometheus server started'))
  .catch((err) => console.error('Prometheus server startup failed:', err));

/*
 * TODO: if PRISMA throws an error the entire express application crashes.
 *  This is a temporary workaround to catch these kind of errors.
 *
 * Will add a global error handler middleware to handle these errors instead.
 * */
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err); // Fallback to console
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason); // Fallback to console
  process.exit(1);
});
