import { BaseService, ServiceConfig } from './BaseService.js';

class HealthService extends BaseService {
  static async create(config: ServiceConfig): Promise<HealthService> {
    return new HealthService(config);
  }

  constructor(config: ServiceConfig) {
    super(config);

    this.router.get('', (_, res) => {
      res.status(200).send('OK');
    });
  }
}

export { HealthService };
