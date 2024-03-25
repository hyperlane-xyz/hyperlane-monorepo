import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { TestRecipient__factory } from '@hyperlane-xyz/core';
import {
  Chains,
  HyperlaneApp,
  HyperlaneAppChecker,
  MultiProvider,
  OwnableConfig,
  TestRecipientDeployer,
} from '@hyperlane-xyz/sdk';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from './HyperlaneAppGovernor';

export class TestApp extends HyperlaneApp<{}> {}

export class TestChecker extends HyperlaneAppChecker<TestApp, OwnableConfig> {
  async checkChain(_: string): Promise<void> {
    this.addViolation({
      chain: Chains.test2,
      type: 'test',
      expected: 0,
      actual: 1,
    });
  }
}

export class HyperlaneTestGovernor extends HyperlaneAppGovernor<
  TestApp,
  OwnableConfig
> {
  protected async mapViolationsToCalls() {
    return;
  }

  mockPushCall(chain: string, call: AnnotatedCallData): void {
    this.pushCall(chain, call);
  }
}

describe('ICA governance', async () => {
  const remoteChain = Chains.test2;

  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;

  before(async () => {
    [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
  });

  it('govern', async () => {
    const recipientF = new TestRecipient__factory(signer);
    const recipient = await recipientF.deploy();

    const contractsMap = {
      [remoteChain]: {
        recipient,
      },
    };
    // missing ica
    const configMap = {
      [remoteChain]: {
        owner: { origin: Chains.test1, owner: signer.address },
      },
    };

    const recipientConfigMap = {
      [remoteChain]: {
        interchainSecurityModule: signer.address,
      },
    };

    const deployer = new TestRecipientDeployer(multiProvider);
    await deployer.deploy(recipientConfigMap);

    const app = new TestApp(contractsMap, multiProvider);
    const checker = new TestChecker(multiProvider, app, configMap);

    const governor = new HyperlaneTestGovernor(checker);

    await governor.checker.checkChain(Chains.test2);
    const call = {
      to: recipient.address,
      data: recipient.interface.encodeFunctionData('transferOwnership', [
        signer.address,
      ]),
      value: BigNumber.from(0),
      description: 'Transfer ownership',
    };
    governor.mockPushCall(remoteChain, call);

    await governor.govern();
  });
});
