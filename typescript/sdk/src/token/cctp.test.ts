import { expect } from 'chai';
import sinon from 'sinon';

import { IMessageTransmitter__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { deriveCctpDomains } from './cctp.js';
import { TokenType } from './config.js';
import { HypTokenRouterConfig } from './types.js';

const ADDRESS_1 = '0x1111111111111111111111111111111111111111';
const ADDRESS_2 = '0x2222222222222222222222222222222222222222';
const ADDRESS_3 = '0x3333333333333333333333333333333333333333';

describe('deriveCctpDomains', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => sandbox.restore());

  it('derives route-wide domain pairs and ignores non-CCTP legs', async () => {
    const multiProvider = MultiProvider.createTestMultiProvider();
    sandbox
      .stub(IMessageTransmitter__factory, 'connect')
      .callsFake((address) => {
        const circleDomain = address === ADDRESS_1 ? 10 : 20;
        return {
          localDomain: async () => circleDomain,
          // CAST: test stub implements only the MessageTransmitter member under test.
        } as ReturnType<typeof IMessageTransmitter__factory.connect>;
      });
    const cctpConfig = (messageTransmitter: string): HypTokenRouterConfig => ({
      type: TokenType.collateralCctp,
      token: ADDRESS_3,
      mailbox: ADDRESS_3,
      owner: ADDRESS_3,
      tokenMessenger: ADDRESS_3,
      messageTransmitter,
      cctpVersion: 'V2',
      urls: [],
    });

    const domains = await deriveCctpDomains(multiProvider, {
      [TestChainName.test1]: cctpConfig(ADDRESS_1),
      [TestChainName.test2]: cctpConfig(ADDRESS_2),
      [TestChainName.test3]: {
        type: TokenType.synthetic,
      },
    });

    expect(domains).to.deep.equal([
      { hyperlane: multiProvider.getDomainId(TestChainName.test1), circle: 10 },
      { hyperlane: multiProvider.getDomainId(TestChainName.test2), circle: 20 },
    ]);
  });
});
