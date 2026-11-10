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
  layerzero: {
    async create(name) {
      const { LayerZeroPacketService } =
        await import('./services/LayerZeroPacketService.js');
      return LayerZeroPacketService.create(name);
    },
  },
  opstack: {
    async create(name) {
      const { OPStackService } = await import('./services/OPStackService.js');
      return OPStackService.create(name);
    },
  },
  wormhole: {
    async create(name) {
      const { WormholeVaaService } =
        await import('./services/WormholeVaaService.js');
      return WormholeVaaService.create(name);
    },
  },
};
