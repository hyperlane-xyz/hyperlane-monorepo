import { Router } from 'express';
import { Logger } from 'pino';

import { BaseService } from './BaseService.js';

class HealthService extends BaseService {
  // External Services
  public readonly router: Router;

  static initialize(logger: Logger): Promise<BaseService> {
    return Promise.resolve(new HealthService(logger));
  }

  constructor(logger: Logger) {
    super(logger);
    this.router = Router();

    this.router.get('', (_, res) => {
      res.status(200).send('OK');
    });
  }
}

export { HealthService };
