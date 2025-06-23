import cors from 'cors';
import express from 'express';

import { getEnabledModules } from './config.js';
import { BaseService } from './services/BaseService.js';
import { CCTPService } from './services/CCTPService.js';
import { CallCommitmentsService } from './services/CallCommitmentsService.js';
import { HealthService } from './services/HealthService.js';
import { OPStackService } from './services/OPStackService.js';
import {
  PrometheusMetrics,
  startPrometheusServer,
} from './utils/prometheus.js';

export const moduleRegistry: Record<string, typeof BaseService> = {
  callCommitments: CallCommitmentsService,
  cctp: CCTPService,
  opstack: OPStackService,
};

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json() as express.RequestHandler);

  if (getEnabledModules().length === 0) {
    console.warn(
      '⚠️  No modules enabled. Set ENABLED_MODULES environment variable to mount services.',
    );
  }

  // Dynamically mount only modules listed in the ENABLED_MODULES env var
  for (const name of getEnabledModules()) {
    try {
      const ServiceClass = moduleRegistry[name];
      if (!ServiceClass) {
        console.warn(`⚠️  Module '${name}' not found; skipping`);
        continue;
      }
      const service = await ServiceClass.initialize(name); // module reads its own ENV config

      app.use(`/${name}`, (req, res, next) => {
        res.on('finish', () => {
          PrometheusMetrics.logLookupRequest(name, res.statusCode);
        });
        next();
      });
      app.use(`/${name}`, service.router);

      console.log(`✅  Mounted '${name}' at '/${name}'`);
    } catch (error) {
      console.error(`Error initializing module ${name}`);
      throw error;
    }
  }

  // Register Health Service
  const healthService = await HealthService.initialize();
  app.use(`/health`, healthService.router);

  // Log and handle undefined endpoints
  app.use((req, res) => {
    console.log(`Undefined request: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Endpoint not found' });
  });

  const port = parseInt(process.env.SERVER_PORT ?? '3000');
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

startServer().then(console.log).catch(console.error);
startPrometheusServer().then(console.log).catch(console.error);

/*
 * TODO: if PRISMA throws an error the entire express application crashes.
 *  This is a temporary workaround to catch these kind of errors.
 * */
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', JSON.stringify(err.message));
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', JSON.stringify(reason));
});
