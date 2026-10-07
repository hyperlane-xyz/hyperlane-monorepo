import { expect } from 'chai';
import { ContractTransaction } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  DomainRoutingHook,
  DomainRoutingHook__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { submitRoutingHookConfigs } from './utils.js';

describe('submitRoutingHookConfigs', () => {
  const chain = TestChainName.test1;
  const FIRST_DESTINATION = 1000;

  let signer: Awaited<ReturnType<typeof hre.ethers.getSigners>>[number];
  let multiProvider: MultiProvider;
  let routingHook: DomainRoutingHook;
  let hookAddress: string;
  let sent: ContractTransaction[];

  function recordSentTxs(provider: MultiProvider) {
    const handleTx = provider.handleTx.bind(provider);
    sinon
      .stub(provider, 'handleTx')
      .callsFake(async (chainNameOrId, tx, options) => {
        const response = await tx;
        sent.push(response);
        return handleTx(chainNameOrId, response, options);
      });
  }

  beforeEach(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const mailbox = await new Mailbox__factory(signer).deploy(
      multiProvider.getDomainId(chain),
    );
    hookAddress = mailbox.address;
    routingHook = await new DomainRoutingHook__factory(signer).deploy(
      mailbox.address,
      await signer.getAddress(),
    );

    sent = [];
    recordSentTxs(multiProvider);
  });

  afterEach(() => {
    sinon.restore();
  });

  function configs(count: number): DomainRoutingHook.HookConfigStruct[] {
    return Array.from({ length: count }, (_, i) => ({
      destination: FIRST_DESTINATION + i,
      hook: hookAddress,
    }));
  }

  function sentBatchSizes(): number[] {
    return sent.map(
      (tx) =>
        routingHook.interface.decodeFunctionData('setHooks', tx.data)[0].length,
    );
  }

  interface Case {
    name: string;
    configCount: number;
    expectedBatchSizes: number[];
  }
  const cases: Case[] = [
    {
      name: 'splits the configs into the default batch size',
      configCount: 130,
      expectedBatchSizes: [64, 64, 2],
    },
    {
      name: 'sends a single batch when the configs fit',
      configCount: 64,
      expectedBatchSizes: [64],
    },
    {
      name: 'sends nothing for no configs',
      configCount: 0,
      expectedBatchSizes: [],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const all = configs(c.configCount);

      await submitRoutingHookConfigs({
        multiProvider,
        chain,
        routingHook,
        configs: all,
        logger: rootLogger,
        label: 'test routing hook configs',
      });

      expect(sentBatchSizes()).to.deep.equal(c.expectedBatchSizes);
      for (const config of all) {
        expect(await routingHook.hooks(config.destination)).to.equal(
          hookAddress,
        );
      }
    });
  }

  it('buffers the gas limit above the estimate', async () => {
    const all = configs(2);
    const estimate = await routingHook.estimateGas.setHooks(all);

    await submitRoutingHookConfigs({
      multiProvider,
      chain,
      routingHook,
      configs: all,
      logger: rootLogger,
      label: 'test routing hook configs',
    });

    expect(sent).to.have.length(1);
    expect(sent[0].gasLimit.gt(estimate)).to.equal(true);
    expect(sent[0].gasLimit.lte(estimate.mul(2))).to.equal(true);
  });

  it('lets the chain transaction overrides replace the buffered gas limit', async () => {
    const OVERRIDE_GAS_LIMIT = 5_000_000;
    const overridden = multiProvider.extendChainMetadata({
      [chain]: { transactionOverrides: { gasLimit: OVERRIDE_GAS_LIMIT } },
    });
    overridden.setSharedSigner(signer);
    const { provider } = signer;
    assert(provider, 'expected the signer to have a provider');
    overridden.setProviders({ [chain]: provider });
    recordSentTxs(overridden);

    await submitRoutingHookConfigs({
      multiProvider: overridden,
      chain,
      routingHook,
      configs: configs(2),
      logger: rootLogger,
      label: 'test routing hook configs',
    });

    expect(sent).to.have.length(1);
    expect(sent[0].gasLimit.toNumber()).to.equal(OVERRIDE_GAS_LIMIT);
  });
});
