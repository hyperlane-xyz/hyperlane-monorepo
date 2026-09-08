import type { ServiceFactory } from './services/BaseService.js';

// Keep optional module dependencies out of startup until that module is enabled.
export const moduleRegistry: Record<string, ServiceFactory> = {
  callCommitments: {
    async create(name) {
      const { CallCommitmentsService } =
        await import('./services/CallCommitmentsService.js');
      return CallCommitmentsService.create(name);
    },
  },
  cctp: {
    async create(name) {
      const { CCTPService } = await import('./services/CCTPService.js');
      return CCTPService.create(name);
    },
  },
  opstack: {
    async create(name) {
      const { OPStackService } = await import('./services/OPStackService.js');
      return OPStackService.create(name);
    },
  },
};
