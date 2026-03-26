import { expect } from 'chai';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  TestChainName,
  test1,
  testChainMetadata,
} from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { TokenType } from './config.js';
import { deriveTokenMetadata } from './tokenMetadataUtils.js';
import { WarpRouteDeployConfig } from './types.js';

describe('deriveTokenMetadata', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('applies successful metadata updates before a later chain derivation fails', async () => {
    const multiProvider = new MultiProvider(testChainMetadata);
    const owner = '0x000000000000000000000000000000000000dEaD';
    const mailbox = '0x000000000000000000000000000000000000b001';
    const updateSpy = sandbox.spy(TokenMetadataMap.prototype, 'update');

    sandbox.stub(multiProvider, 'getProtocol').returns(ProtocolType.Ethereum);
    sandbox.stub(multiProvider, 'getChainMetadata').callsFake((chain) => {
      if (chain === TestChainName.test2) {
        throw new Error('test rpc error');
      }
      return testChainMetadata[chain];
    });

    const configMap: WarpRouteDeployConfig = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
    };

    try {
      await deriveTokenMetadata(multiProvider, configMap);
      expect.fail('expected deriveTokenMetadata to throw');
    } catch (error) {
      expect((error as Error).message).to.equal('test rpc error');
    }

    expect(
      updateSpy.calledWith(
        TestChainName.test1,
        sinon.match({
          decimals: test1.nativeToken!.decimals,
          name: test1.nativeToken!.name,
          symbol: test1.nativeToken!.symbol,
        }),
      ),
    ).to.equal(true);
  });
});
