import { ethers } from 'ethers';

import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  HyperlaneCoreDeployer,
  HyperlaneIsmFactory,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { DeployOptions } from '@hyperlane-xyz/sdk/dist/deploy/HyperlaneDeployer';
import { types } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config';

export class HyperlaneCoreInfraDeployer extends HyperlaneCoreDeployer {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    ismFactory: HyperlaneIsmFactory,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap, ismFactory);
    this.environment = environment;
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    proxyAdmin: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<Mailbox> {
    return super.deployMailbox(chain, defaultIsmAddress, proxyAdmin, {
      ...deployOpts,
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'mailbox', 1],
      ),
    });
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: types.Address,
  ): Promise<ValidatorAnnounce> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'validatorAnnounce', 1],
      ),
    };
    return super.deployValidatorAnnounce(chain, mailboxAddress, deployOpts);
  }
}
