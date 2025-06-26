import { BaseService, ServiceConfig } from './BaseService.js';

class HealthService extends BaseService {
  static async create(_name: string): Promise<HealthService> {
    return new HealthService({});
  }

  constructor(config: ServiceConfig) {
    super(config);

    this.router.get('', (_, res) => {
      res.status(200).send('OK');
    });
  }
}

export { HealthService };
