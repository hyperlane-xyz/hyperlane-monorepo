import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Wallet, ethers } from 'ethers';
import { $ } from 'zx';

import {
  InterchainAccountRouter__factory,
  Mailbox__factory,
  ProtocolFee__factory,
} from '@hyperlane-xyz/core';
import { HookType, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { type ExtendedSubmissionStrategy } from '../../../submitters/types.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { localTestRunCmdPrefix } from '../commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane hook apply through an ICA', function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  let temporaryDirectory: string;

  before(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hook-apply-ica-'),
    );
  });

  after(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('submits from the ICA origin and updates the destination hook on delivery', async () => {
    const [originAddresses, destinationAddresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
    assert(
      originAddresses.interchainAccountRouter,
      'Missing origin ICA router',
    );
    assert(
      destinationAddresses.interchainAccountRouter,
      'Missing destination ICA router',
    );
    assert(originAddresses.mailbox, 'Missing origin mailbox');
    assert(destinationAddresses.mailbox, 'Missing destination mailbox');

    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
    });
    const originWallet = new Wallet(
      ANVIL_KEY,
      multiProvider.getProvider(CHAIN_NAME_2),
    );
    const destinationWallet = new Wallet(
      ANVIL_KEY,
      multiProvider.getProvider(CHAIN_NAME_3),
    );
    const originDomain = multiProvider.getDomainId(CHAIN_NAME_2);
    const destinationDomain = multiProvider.getDomainId(CHAIN_NAME_3);
    const originRouter = InterchainAccountRouter__factory.connect(
      originAddresses.interchainAccountRouter,
      originWallet,
    );
    const destinationRouter = InterchainAccountRouter__factory.connect(
      destinationAddresses.interchainAccountRouter,
      destinationWallet,
    );
    await (
      await originRouter.enrollRemoteRouterAndIsm(
        destinationDomain,
        addressToBytes32(destinationRouter.address),
        ethers.constants.HashZero,
      )
    ).wait();
    await (
      await destinationRouter.enrollRemoteRouterAndIsm(
        originDomain,
        addressToBytes32(originRouter.address),
        ethers.constants.HashZero,
      )
    ).wait();

    const icaAddress = await destinationRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](
      originDomain,
      originWallet.address,
      originRouter.address,
      ethers.constants.AddressZero,
    );
    const hook = await new ProtocolFee__factory(destinationWallet).deploy(
      100,
      1,
      originWallet.address,
      icaAddress,
    );
    await hook.deployed();

    const configPath = path.join(temporaryDirectory, 'hook.yaml');
    writeYamlOrJson(configPath, {
      type: HookType.PROTOCOL_FEE,
      owner: icaAddress,
      beneficiary: originWallet.address,
      maxProtocolFee: '100',
      protocolFee: '2',
    });
    const strategy: Record<string, ExtendedSubmissionStrategy> = {
      [CHAIN_NAME_3]: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: CHAIN_NAME_2,
          destinationChain: CHAIN_NAME_3,
          owner: originWallet.address,
          internalSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME_2,
          },
        },
      },
    };
    const strategyPath = path.join(temporaryDirectory, 'strategy.yaml');
    writeYamlOrJson(strategyPath, strategy);

    const originMailbox = Mailbox__factory.connect(
      originAddresses.mailbox,
      originWallet,
    );
    const beforeBlock = await originWallet.provider.getBlockNumber();
    const result = await $`${localTestRunCmdPrefix()} hyperlane hook apply \
      --registry ${REGISTRY_PATH} --chain ${CHAIN_NAME_3} --address ${hook.address} \
      --config ${configPath} --strategy ${strategyPath} --key ${ANVIL_KEY} --yes`;
    expect(result.exitCode).to.equal(0);

    const dispatches = await originMailbox.queryFilter(
      originMailbox.filters.Dispatch(originRouter.address),
      beforeBlock,
    );
    expect(dispatches).to.have.lengthOf(1);
    const [dispatch] = dispatches;
    assert(dispatch, 'Missing ICA dispatch');
    expect(dispatch.args.recipient).to.equal(
      addressToBytes32(destinationRouter.address),
    );
    expect((await hook.protocolFee()).toString()).to.equal('1');

    const destinationMailbox = Mailbox__factory.connect(
      destinationAddresses.mailbox,
      destinationWallet,
    );
    // The test core's TestIsm accepts the message; use the real Mailbox process
    // and ICA execution path so the ownership change is proven on destination.
    await (
      await destinationMailbox.process('0x', dispatch.args.message)
    ).wait();
    expect((await hook.protocolFee()).toString()).to.equal('2');
    expect(await hook.owner()).to.equal(icaAddress);
  });
});
