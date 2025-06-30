import { BaseService, ServiceConfig } from './BaseService.js';

class HealthService extends BaseService {
  static async create(serviceName: string): Promise<HealthService> {
    return new HealthService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);

    this.router.get('', (_, res) => {
      res.status(200).send('OK');
    });
  }
}

export { HealthService };
