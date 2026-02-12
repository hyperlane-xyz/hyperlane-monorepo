import { expect } from 'chai';
import { ContractFactory } from 'ethers';

import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  Mailbox__factory as TronMailbox__factory,
  ProxyAdmin__factory as TronProxyAdmin__factory,
  TronContractFactory,
  TestRecipient__factory as TronTestRecipient__factory,
} from '@hyperlane-xyz/tron-sdk';

import { MultiProvider } from './MultiProvider.js';

describe('MultiProvider Tron factory resolution', () => {
  const mp = new MultiProvider({});

  it('resolves Mailbox to tron factory with different bytecode', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(resolved).to.be.instanceOf(TronContractFactory);
    expect(resolved.bytecode).to.equal(new TronMailbox__factory().bytecode);
    expect(resolved.bytecode).to.not.equal(new Mailbox__factory().bytecode);
  });

  it('resolves ProxyAdmin to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new ProxyAdmin__factory());
    expect(resolved).to.be.instanceOf(TronContractFactory);
    expect(resolved.bytecode).to.equal(new TronProxyAdmin__factory().bytecode);
  });

  it('resolves TestRecipient to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new TestRecipient__factory());
    expect(resolved).to.be.instanceOf(TronContractFactory);
    expect(resolved.bytecode).to.equal(
      new TronTestRecipient__factory().bytecode,
    );
  });

  it('preserves ABI when resolving', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(JSON.stringify(resolved.interface.fragments)).to.equal(
      JSON.stringify(new Mailbox__factory().interface.fragments),
    );
  });

  it('throws for unknown factory', async () => {
    class Unknown__factory extends ContractFactory {
      constructor() {
        super([], '0x');
      }
    }
    try {
      await mp.resolveTronFactory(new Unknown__factory());
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('No Tron-compiled factory found for');
    }
  });
});
