import { Router } from 'express';

import { BaseService } from './BaseService.js';

class HealthService extends BaseService {
  // External Services
  public readonly router: Router;

  static initialize(): Promise<BaseService> {
    return Promise.resolve(new HealthService());
  }

  constructor() {
    super();
    this.router = Router();

    this.router.get('', (_, res) => {
      res.status(200).send('OK');
    });
  }
}

export { HealthService };
