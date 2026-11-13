import { expect } from 'chai';

import { Contexts } from '../config/contexts.js';
import { chainMetadataOverrides as mainnet3Metadata } from '../config/environments/mainnet3/chains.js';
import { supportedChainNames as mainnet3Chains } from '../config/environments/mainnet3/supportedChainNames.js';
import { validatorChainConfig as mainnet3Validators } from '../config/environments/mainnet3/validators.js';
import { chainMetadataOverrides as testnet4Metadata } from '../config/environments/testnet4/chains.js';
import { supportedChainNames as testnet4Chains } from '../config/environments/testnet4/supportedChainNames.js';
import { validatorChainConfig as testnet4Validators } from '../config/environments/testnet4/validators.js';

const chainNameLists: Array<[string, readonly string[]]> = [
  ['mainnet3 supportedChainNames', mainnet3Chains],
  ['mainnet3 chainMetadataOverrides', Object.keys(mainnet3Metadata)],
  [
    'mainnet3 validatorChainConfig',
    Object.keys(mainnet3Validators(Contexts.Hyperlane)),
  ],
  ['testnet4 supportedChainNames', testnet4Chains],
  ['testnet4 chainMetadataOverrides', Object.keys(testnet4Metadata)],
  [
    'testnet4 validatorChainConfig',
    Object.keys(testnet4Validators(Contexts.Hyperlane)),
  ],
];

describe('alphabetical chain name ordering', () => {
  for (const [label, names] of chainNameLists) {
    it(`keeps ${label} alphabetical`, () => {
      expect(names, label).to.not.be.empty;
      expect(names, label).to.deep.equal([...names].sort());
    });
  }
});
