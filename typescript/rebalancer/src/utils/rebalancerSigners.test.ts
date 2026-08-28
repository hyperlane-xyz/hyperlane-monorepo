import { expect } from 'chai';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { TronJsonRpcProvider, TronWallet } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { configureRebalancerSigners } from './rebalancerSigners.js';

const PRIVATE_KEY = `0x${'01'.repeat(32)}`;

describe('configureRebalancerSigners', () => {
  it('uses TronWallet on Tron and ethers Wallet elsewhere', async () => {
    const multiProvider = new MultiProvider({
      ethereum: {
        name: 'ethereum',
        chainId: 1,
        domainId: 1,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'http://ethereum.invalid' }],
      },
      tron: {
        name: 'tron',
        chainId: 728126428,
        domainId: 728126428,
        protocol: ProtocolType.Tron,
        rpcUrls: [{ http: 'http://tron.invalid' }],
      },
    });

    const setup = configureRebalancerSigners(
      multiProvider,
      ['ethereum', 'tron'],
      PRIVATE_KEY,
    );

    expect(setup.tronChains).to.deep.equal(['tron']);
    expect(multiProvider.getSigner('tron')).to.be.instanceOf(TronWallet);
    expect(multiProvider.getSigner('ethereum')).not.to.be.instanceOf(
      TronWallet,
    );
    expect(await multiProvider.getSignerAddress('tron')).to.equal(
      setup.address,
    );
  });

  it('uses the configured Tron RPC URL including custom headers', () => {
    const tronRpcUrl =
      'https://tron.example/jsonrpc?custom_rpc_header=X-Api-Key:secret';
    const multiProvider = new MultiProvider({
      tron: {
        name: 'tron',
        chainId: 728126428,
        domainId: 728126428,
        protocol: ProtocolType.Tron,
        rpcUrls: [{ http: tronRpcUrl }],
      },
    });

    configureRebalancerSigners(multiProvider, ['tron'], PRIVATE_KEY);

    const provider = multiProvider.getSigner('tron').provider;
    expect(provider).to.be.instanceOf(TronJsonRpcProvider);
    if (!(provider instanceof TronJsonRpcProvider)) {
      throw new Error('Expected Tron signer to use TronJsonRpcProvider');
    }
    expect(provider.host).to.equal(tronRpcUrl);
    expect(provider.connection.url).to.equal('https://tron.example/jsonrpc');
    expect(provider.connection.headers).to.deep.include({
      'X-Api-Key': 'secret',
    });
  });

  it('configures duplicate strategy chains once', () => {
    const multiProvider = new MultiProvider({
      tron: {
        name: 'tron',
        chainId: 728126428,
        domainId: 728126428,
        protocol: ProtocolType.Tron,
        rpcUrls: [{ http: 'http://tron.invalid' }],
      },
    });

    const setup = configureRebalancerSigners(
      multiProvider,
      ['tron', 'tron'],
      PRIVATE_KEY,
    );

    expect(setup.tronChains).to.deep.equal(['tron']);
  });

  it('requires an HTTP RPC URL for Tron', () => {
    const multiProvider = new MultiProvider({
      tron: {
        name: 'tron',
        chainId: 728126428,
        domainId: 728126428,
        protocol: ProtocolType.Tron,
        rpcUrls: [{ http: 'http://tron.invalid' }],
      },
    });
    multiProvider.metadata.tron.rpcUrls.splice(0);

    expect(() =>
      configureRebalancerSigners(multiProvider, ['tron'], PRIVATE_KEY),
    ).to.throw('No RPC URLs configured for tron');
  });
});
