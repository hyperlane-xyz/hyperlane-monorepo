import { expect } from 'chai';

import {
  test1,
  testCosmosChain,
  testSealevelChain,
} from '../consts/testChains.js';

import {
  getExplorerAddressUrl,
  getExplorerApiUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from './blockExplorer.js';

const TEST_CHAINS = [test1, testCosmosChain, testSealevelChain];
const EXPECTED_RESULTS = [
  [
    'https://etherscan.io/',
    'https://api.etherscan.io/api?apikey=fakekey',
    'https://etherscan.io/tx/0x123',
    'https://etherscan.io/address/0x123',
  ],
  [
    'https://www.mintscan.io/cosmos',
    null,
    'https://www.mintscan.io/cosmos/tx/0x123',
    'https://www.mintscan.io/cosmos/address/0x123',
  ],
  [
    'https://explorer.solana.com/?cluster=devnet',
    null,
    'https://explorer.solana.com/tx/0x123?cluster=devnet',
    'https://explorer.solana.com/address/0x123?cluster=devnet',
  ],
];

describe('Block explorer utils', () => {
  TEST_CHAINS.map((chain, i) => {
    it(`gets a base url correctly for protocol ${chain.protocol}`, () => {
      expect(getExplorerBaseUrl(chain)).to.equal(EXPECTED_RESULTS[i][0]);
    });
    it(`gets an api url for protocol ${chain.protocol}`, () => {
      expect(getExplorerApiUrl(chain)).to.equal(EXPECTED_RESULTS[i][1]);
    });
    it(`gets a tx url for protocol ${chain.protocol}`, () => {
      expect(getExplorerTxUrl(chain, '0x123')).to.equal(EXPECTED_RESULTS[i][2]);
    });
    it(`gets an address url for protocol ${chain.protocol}`, () => {
      expect(getExplorerAddressUrl(chain, '0x123')).to.equal(
        EXPECTED_RESULTS[i][3],
      );
    });
  });
});
