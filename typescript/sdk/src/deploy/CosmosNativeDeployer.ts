import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { HookConfig, HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

export class CosmosNativeDeployer {
  private readonly logger: Logger;

  constructor(
    protected readonly multiProvider: MultiProvider,
    private readonly signer: SigningHyperlaneModuleClient,
  ) {
    this.logger = rootLogger.child({ module: 'CosmosNativeDeployer' });
  }

  async deployIsm(params: {
    chain: ChainName;
    ismConfig: IsmConfig;
  }): Promise<Address> {
    const { chain, ismConfig } = params;
    if (typeof ismConfig === 'string') {
      return ismConfig;
    }
    const ismType = ismConfig.type;
    this.logger.info(`Deploying ${ismType} to ${chain}`);

    switch (ismType) {
      case IsmType.MERKLE_ROOT_MULTISIG:
        const { response: merkleRootResponse } =
          await this.signer.createMerkleRootMultisigIsm({
            validators: ismConfig.validators,
            threshold: ismConfig.threshold,
          });
        return merkleRootResponse.id;
      case IsmType.MESSAGE_ID_MULTISIG:
        const { response: messageIdResponse } =
          await this.signer.createMessageIdMultisigIsm({
            validators: ismConfig.validators,
            threshold: ismConfig.threshold,
          });
        return messageIdResponse.id;
      case IsmType.TEST_ISM:
        const { response: noopResponse } = await this.signer.createNoopIsm({});
        return noopResponse.id;
      default:
        throw new Error(`ISM type ${ismType} is not supported on Cosmos`);
    }
  }

  async deployHook(params: {
    chain: ChainName;
    hookConfig: HookConfig;
    mailbox: Address;
  }): Promise<Address> {
    const { chain, hookConfig, mailbox } = params;
    if (typeof hookConfig === 'string') {
      return hookConfig;
    }
    const hookType = hookConfig.type;
    this.logger.info(`Deploying ${hookType} to ${chain}`);

    switch (hookType) {
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        // TODO: what about denom?
        const { nativeToken } = this.multiProvider.getChainMetadata(chain);

        const { response: igp } = await this.signer.createIgp({
          denom: nativeToken?.denom ?? '',
        });

        for (const [remote, config] of Object.entries(
          hookConfig.oracleConfig,
        )) {
          const remoteDomain = this.multiProvider.tryGetDomainId(remote);
          if (remoteDomain === null) {
            this.logger.warn(`Skipping gas oracle ${chain} -> ${remote}.`);
            continue;
          }

          await this.signer.setDestinationGasConfig({
            igp_id: igp.id,
            destination_gas_config: {
              remote_domain: remoteDomain,
              gas_overhead: hookConfig.overhead[remote].toString(),
              gas_oracle: {
                token_exchange_rate: config.tokenExchangeRate,
                gas_price: config.gasPrice,
              },
            },
          });
        }

        if (
          hookConfig.owner &&
          this.signer.account.address !== hookConfig.owner
        ) {
          await this.signer.setIgpOwner({
            igp_id: igp.id,
            new_owner: hookConfig.owner,
          });
        }

        return igp.id;
      case HookType.MERKLE_TREE:
        const { response: merkleTree } = await this.signer.createMerkleTreeHook(
          {
            mailbox_id: mailbox,
          },
        );

        return merkleTree.id;
      case HookType.MAILBOX_DEFAULT:
        // TODO: is mailbox default noop?
        const { response: noopResponse } = await this.signer.createNoopHook({});
        return noopResponse.id;
      default:
        throw new Error(`Hook type ${hookType} is not supported on Cosmos`);
    }
  }
}
