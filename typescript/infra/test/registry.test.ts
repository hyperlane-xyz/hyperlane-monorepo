import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';

import { supportedChainNames as mainnet3Chains } from '../config/environments/mainnet3/supportedChainNames.js';
import {
  DEFAULT_REGISTRY_URI,
  getRegistry,
  resetRegistry,
} from '../config/registry.js';

describe('Registry defaults', () => {
  const originalRegistryUri = process.env.REGISTRY_URI;
  let tempRegistryDir: string | undefined;

  beforeEach(() => {
    delete process.env.REGISTRY_URI;
    resetRegistry();
  });

  afterEach(() => {
    if (tempRegistryDir) {
      rmSync(tempRegistryDir, { recursive: true, force: true });
      tempRegistryDir = undefined;
    }

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

  it('prefers REGISTRY_URI when explicitly provided', () => {
    tempRegistryDir = mkdtempSync(join(tmpdir(), 'hyperlane-registry-test-'));
    process.env.REGISTRY_URI = tempRegistryDir;
    resetRegistry();

    const registry = getRegistry();
    expect(registry.getUri()).to.equal(tempRegistryDir);
  });

  it('throws a clear error for a missing REGISTRY_URI path', () => {
    process.env.REGISTRY_URI = join(
      tmpdir(),
      'hyperlane-registry-does-not-exist',
    );
    resetRegistry();

    expect(() => getRegistry()).to.throw(
      `Registry URI does not exist on disk: ${process.env.REGISTRY_URI}`,
    );
  });
});
