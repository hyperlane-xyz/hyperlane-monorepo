import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

import {
  DEFAULT_REGISTRY_URI,
  getChain,
  getRegistry,
} from '../config/registry.js';

describe('Registry path defaults', () => {
  it('resolves to the repo-local hyperlane-registry directory', () => {
    const expectedRegistryPath = path.resolve(
      process.cwd(),
      '../../hyperlane-registry',
    );

    expect(DEFAULT_REGISTRY_URI).to.equal(expectedRegistryPath);
  });

  it('loads Abstract metadata from the default registry when present', function () {
    if (!fs.existsSync(DEFAULT_REGISTRY_URI)) {
      this.skip();
      return;
    }

    const chainMetadata = getRegistry().getChainMetadata('abstract');
    expect(chainMetadata?.name).to.equal('abstract');
  });

  it('resolves abstract through infra getChain helper', function () {
    if (!fs.existsSync(DEFAULT_REGISTRY_URI)) {
      this.skip();
      return;
    }

    const chainMetadata = getChain('abstract');
    expect(chainMetadata.name).to.equal('abstract');
    expect(chainMetadata.domainId).to.equal(2741);
  });
});
