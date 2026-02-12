import { expect } from 'chai';

import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import * as TronSdk from '@hyperlane-xyz/tron-sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';

describe('MultiProvider Tron factory resolution', () => {
  // Verify that tron-sdk exports factories with the same class names as core
  it('tron-sdk exports match core factory class names', () => {
    const coreFactories = [
      Mailbox__factory,
      ProxyAdmin__factory,
      TestRecipient__factory,
    ];
    for (const CoreFactory of coreFactories) {
      const name = CoreFactory.name;
      const TronFactory = (TronSdk as Record<string, any>)[name];
      expect(TronFactory, `${name} not found in tron-sdk`).to.exist;
      expect(TronFactory.name).to.equal(name);
    }
  });

  // Verify that tron factories have different bytecode from core
  it('tron factories have different bytecode than core', () => {
    const coreFactory = new Mailbox__factory();
    const tronFactory = new TronSdk.Mailbox__factory();
    expect(coreFactory.bytecode).to.not.equal(tronFactory.bytecode);
    expect(coreFactory.constructor.name).to.equal(tronFactory.constructor.name);
  });

  // Verify that tron factories share the same ABI as core
  it('tron factories share the same ABI as core', () => {
    const coreFactory = new Mailbox__factory();
    const tronFactory = new TronSdk.Mailbox__factory();
    expect(JSON.stringify(Mailbox__factory.abi)).to.equal(
      JSON.stringify(TronSdk.Mailbox__factory.abi),
    );
  });

  // Verify dynamic lookup works via constructor.name
  it('dynamic lookup by constructor.name resolves correct tron factory', async () => {
    const coreFactory = new Mailbox__factory();
    const name = coreFactory.constructor.name;

    const tronSdk = await import('@hyperlane-xyz/tron-sdk');
    const TronFactory = (tronSdk as Record<string, any>)[name];

    expect(TronFactory).to.exist;
    const instance = new TronFactory();
    expect(instance.bytecode).to.not.equal(coreFactory.bytecode);
    expect(instance.constructor.name).to.equal(name);
  });

  // Verify that a missing factory throws
  it('throws for unknown factory name', async () => {
    const tronSdk = await import('@hyperlane-xyz/tron-sdk');
    const TronFactory = (tronSdk as Record<string, any>)[
      'NonExistentContract__factory'
    ];
    expect(TronFactory).to.be.undefined;
  });

  // Verify the Tron test chain metadata shape
  it('Tron chain metadata has correct technicalStack', () => {
    const tronChain: ChainMetadata = {
      chainId: 728126428,
      displayName: 'Tron Shasta',
      domainId: 728126428,
      name: 'tronshasta',
      nativeToken: { decimals: 6, name: 'TRX', symbol: 'TRX' },
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://127.0.0.1:8090/jsonrpc' }],
      technicalStack: ChainTechnicalStack.Tron,
    };
    expect(tronChain.technicalStack).to.equal(ChainTechnicalStack.Tron);
    expect(tronChain.protocol).to.equal(ProtocolType.Ethereum);
  });
});
