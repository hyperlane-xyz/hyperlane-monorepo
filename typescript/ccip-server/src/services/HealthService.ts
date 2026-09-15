import { BaseService, ServiceConfig } from './BaseService.js';
import type { CcipApp } from '../http.js';

class HealthService extends BaseService {
  static async create(serviceName: string): Promise<HealthService> {
    return new HealthService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);
  }

  registerRoutes(app: CcipApp, prefix: string): void {
    app.get(prefix, async (_request, reply) => {
      return reply.code(200).send('OK');
    });
  }
}

export { HealthService };
