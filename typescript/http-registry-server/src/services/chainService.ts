import { ChainAddresses, UpdateChainParams } from '@hyperlane-xyz/registry';
import { ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';

import { NotFoundError } from '../errors/ApiError.js';

import { AbstractService } from './abstractService.js';
import { RegistryService } from './registryService.js';

export class ChainService extends AbstractService {
  constructor(registryService: RegistryService) {
    super(registryService);
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata> {
    return this.withRegistry(async (registry) => {
      const metadata = await registry.getChainMetadata(chainName);
      if (!metadata) {
        throw new NotFoundError(
          `Chain metadata not found for chain ${chainName}`,
        );
      }
      return metadata;
    });
  }

  async getChainAddresses(chainName: ChainName): Promise<ChainAddresses> {
    return this.withRegistry(async (registry) => {
      const addresses = await registry.getChainAddresses(chainName);
      if (!addresses) {
        throw new NotFoundError(
          `Chain addresses not found for chain ${chainName}`,
        );
      }
      return addresses;
    });
  }

  async updateChain(params: UpdateChainParams): Promise<void> {
    return this.withRegistry(async (registry) => {
      await registry.updateChain(params);
    });
  }
}
