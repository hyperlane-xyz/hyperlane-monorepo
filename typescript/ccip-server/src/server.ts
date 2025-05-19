import cors from 'cors';
import { Router } from 'express';
import express from 'express';

import { getEnabledModules } from './config.js';
import { CCTPService } from './services/CCTPService.js';
import { CallCommitmentsService } from './services/CallCommitmentsService.js';
import { OPStackService } from './services/OPStackService.js';
import { ProofsService } from './services/ProofsService.js';

type ModuleFactory = new (opts?: any) => { router: Router };

export const moduleRegistry: Record<string, ModuleFactory> = {
  callCommitments: CallCommitmentsService,
  proofs: ProofsService,
  cctp: CCTPService,
  opstack: OPStackService,
};

const app = express();
app.use(cors());
app.use(express.json() as express.RequestHandler);

// Dynamically mount only modules listed in the ENABLED_MODULES env var
for (const name of getEnabledModules()) {
  const ServiceClass = moduleRegistry[name];
  if (!ServiceClass) {
    console.warn(`⚠️  Module '${name}' not found; skipping`);
    continue;
  }
  const service = new ServiceClass(); // module reads its own ENV config
  app.use(`/${name}`, service.router);
  console.log(`✅  Mounted '${name}' at '/${name}'`);
}

// Log and handle undefined endpoints
app.use((req, res) => {
  console.log(`Undefined request: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(3000, () => console.log(`Listening on port ${3000}`));
