import { existsSync } from 'fs';

import { expect } from 'chai';

import { supportedChainNames as mainnet3Chains } from '../config/environments/mainnet3/supportedChainNames.js';
import {
  DEFAULT_REGISTRY_URI,
  getRegistry,
  resetRegistry,
} from '../config/registry.js';

describe('Registry defaults', () => {
  const originalRegistryUri = process.env.REGISTRY_URI;

  beforeEach(() => {
    delete process.env.REGISTRY_URI;
    resetRegistry();
  });

  afterEach(() => {
    if (originalRegistryUri) {
      process.env.REGISTRY_URI = originalRegistryUri;
    } else {
      delete process.env.REGISTRY_URI;
    }
    resetRegistry();
  });

  it('uses a registry URI that exists on disk', () => {
    expect(
      existsSync(DEFAULT_REGISTRY_URI),
      `Default registry URI does not exist: ${DEFAULT_REGISTRY_URI}`,
    ).to.equal(true);
  });

  it('loads all configured mainnet3 chains from default registry', () => {
    const registry = getRegistry();

    for (const chainName of mainnet3Chains) {
      expect(
        registry.getChainMetadata(chainName),
        `Missing chain metadata for ${chainName}`,
      ).to.not.be.undefined;
    }
  });
});
