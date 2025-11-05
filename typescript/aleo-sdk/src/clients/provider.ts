import {
  Account,
  AleoNetworkClient,
  BHP256,
  Plaintext,
  Program,
  ProgramManager,
} from '@provablehq/sdk';

import { AltVM, assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { mailbox } from '../artifacts.js';
import { getMessageKey } from '../utils/helper.js';
import { AleoTransaction } from '../utils/types.js';

// TODO: make denom in AltVM optional
// TODO: add remove destination gas config method in AltVM
// TODO: only allow domainId in createMailox in AltVM
// TODO: add createNoopHook method in AltVM
// TODO: add getTokenMetadata method in AltVM
// TODO: don't allow routes in create routing ism

export class AleoProvider implements AltVM.IProvider {
  protected readonly aleoClient: AleoNetworkClient;
  protected readonly rpcUrls: string[];

  static async connect(
    rpcUrls: string[],
    _chainId: string | number,
  ): Promise<AleoProvider> {
    return new AleoProvider(rpcUrls);
  }

  constructor(rpcUrls: string[]) {
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    this.rpcUrls = rpcUrls;
    this.aleoClient = new AleoNetworkClient(rpcUrls[0]);
  }

  // ### QUERY BASE ###

  async isHealthy() {
    const latestBlockHeight = await this.aleoClient.getLatestHeight();
    return latestBlockHeight > 0;
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight() {
    return this.aleoClient.getLatestHeight();
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    if (req.denom) {
      const balanceKey = new BHP256()
        .hash(
          Plaintext.fromString(
            `{account: ${req.address},token_id: ${req.denom}}`,
          ).toBitsLe(),
        )
        .toString();

      const result = await this.aleoClient.getProgramMappingValue(
        'token_registry.aleo',
        'authorized_balances',
        balanceKey,
      );

      if (result === null) {
        return 0n;
      }

      return Plaintext.fromString(result).toObject()['balance'];
    }

    const balance = await this.aleoClient.getPublicBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    if (!req.denom) {
      throw new Error(`Can not get total supply of credits`);
    }

    const result = await this.aleoClient.getProgramMappingValue(
      'token_registry.aleo',
      'registered_tokens',
      req.denom,
    );

    if (result === null) {
      return 0n;
    }

    return Plaintext.fromString(result).toObject()['max_supply'];
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<AleoTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const programManager = new ProgramManager(this.rpcUrls[0]);
    programManager.setAccount(new Account());

    const tx = await programManager.buildExecutionTransaction(req.transaction);

    return {
      fee: tx.feeAmount(),
      gasUnits: 0n,
      gasPrice: 0,
    };
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    let res;
    try {
      res = await this.aleoClient.getProgramMappingPlaintext(
        req.mailboxAddress,
        'mailbox',
        'true',
      );
    } catch {
      throw new Error(`Found no Mailbox for address: ${req.mailboxAddress}`);
    }

    const {
      mailbox_owner,
      local_domain,
      default_ism,
      default_hook,
      required_hook,
      nonce,
    } = res.toObject();

    return {
      address: req.mailboxAddress,
      owner: mailbox_owner,
      localDomain: local_domain,
      defaultIsm: default_ism,
      defaultHook: default_hook,
      requiredHook: required_hook,
      nonce: nonce,
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    try {
      // Message key needs to be separated into [u128, u128] using Little Endian.
      const messageKey = getMessageKey(req.messageId);

      const res = await this.aleoClient.getProgramMappingPlaintext(
        'mailbox.aleo',
        'deliveries',
        `{ id: [ ${messageKey[0].toString()}, ${messageKey[1].toString()} ]}`,
      );

      const obj = res.toObject();

      return Boolean(obj.processor && obj.block_number);
    } catch {
      return false;
    }
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    let res;
    try {
      res = await this.aleoClient.getProgramMappingPlaintext(
        'ism_manager.aleo',
        'isms',
        req.ismAddress,
      );
    } catch {
      throw new Error(`Found no ISM for address: ${req.ismAddress}`);
    }

    switch (res.toObject()) {
      case 0:
        return AltVM.IsmType.TEST_ISM;
      case 1:
        return AltVM.IsmType.ROUTING;
      case 4:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case 5:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      default:
        throw new Error(`Unknown ISM type for address: ${req.ismAddress}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    let res;
    try {
      res = await this.aleoClient.getProgramMappingPlaintext(
        'ism_manager.aleo',
        'message_id_multisigs',
        req.ismAddress,
      );
    } catch {
      throw new Error(`Found no ISM for address: ${req.ismAddress}`);
    }

    const { validators, threshold } = res.toObject();

    const validatorsHex: string[] = [];
    validators.forEach((v: any) => {
      validatorsHex.push(ensure0x(Buffer.from(v.bytes).toString('hex')));
    });

    return {
      address: req.ismAddress,
      validators: validatorsHex,
      threshold: threshold,
    };
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error(`MerkleRootMultisigIsm is currently not supported on Aleo`);
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    const programId = 'ism_manager.aleo';

    let owner: string;
    const routes: { domainId: number; ismAddress: string }[] = [];

    try {
      const ismData = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'domain_routing_isms',
        req.ismAddress,
      );
      owner = ismData.toObject().ism_owner;
    } catch {
      throw new Error(`Found no ISM for address: ${req.ismAddress}`);
    }

    try {
      const routeLengthRes = await this.aleoClient.getProgramMappingValue(
        programId,
        'route_length',
        req.ismAddress,
      );

      for (let i = 0; i < parseInt(routeLengthRes); i++) {
        const routeKey = await this.aleoClient.getProgramMappingPlaintext(
          programId,
          'route_iter',
          `{ ism: ${req.ismAddress}, index: ${i}u32}`,
        );

        const ismAddress = await this.aleoClient.getProgramMappingValue(
          programId,
          'routes',
          routeKey,
        );

        // This is necessary because `route_iter` maintains keys for all route entries,
        // including those from domains that have already been removed. When a domain is
        // deleted from the Routing ISM, its key remains in the map and `routes` simply returns null.
        if (!ismAddress) continue;

        routes.push({
          ismAddress: ismAddress,
          domainId: routeKey.toObject().domain,
        });
      }
    } catch {
      throw new Error(
        `Failed to found routes for ISM address: ${req.ismAddress}`,
      );
    }

    return {
      address: req.ismAddress,
      owner: owner,
      routes: routes,
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    try {
      await this.aleoClient.getProgramMappingPlaintext(
        'ism_manager.aleo',
        'isms',
        req.ismAddress,
      );
    } catch {
      throw new Error(`Found no ISM for address: ${req.ismAddress}`);
    }

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    let res;
    try {
      res = await this.aleoClient.getProgramMappingPlaintext(
        'hook_manager.aleo',
        'hooks',
        req.hookAddress,
      );
    } catch {
      throw new Error(`Found no Hook for address: ${req.hookAddress}`);
    }

    switch (res.toObject()) {
      case 0:
        // TODO: Use NOOP or UNUSED here
        return AltVM.HookType.CUSTOM;
      case 3:
        return AltVM.HookType.MERKLE_TREE;
      case 4:
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      case 7:
        return AltVM.HookType.PAUSABLE;
      default:
        throw new Error(`Unknown Hook type for address: ${req.hookAddress}`);
    }
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const programId = 'hook_manager.aleo';
    let owner: string;

    const destinationGasConfigs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    } = {};

    try {
      const igpDat = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'igps',
        req.hookAddress,
      );
      owner = igpDat.toObject().hook_owner;
    } catch {
      throw new Error(`Found no IGP for address: ${req.hookAddress}`);
    }

    try {
      const gasConfigLength = await this.aleoClient.getProgramMappingValue(
        programId,
        'destination_gas_config_length',
        req.hookAddress,
      );

      for (let i = 0; i < parseInt(gasConfigLength); i++) {
        const gasConfigKey = await this.aleoClient.getProgramMappingPlaintext(
          programId,
          'destination_gas_config_iter',
          `{ hook: ${req.hookAddress}, index: ${i}u32}`,
        );

        const destinationGasConfig =
          await this.aleoClient.getProgramMappingPlaintext(
            programId,
            'destination_gas_configs',
            gasConfigKey,
          );

        // This is necessary because `destination_gas_config_iter` maintains keys for all destination domain entries,
        // including those from domains that have already been removed. When a domain is
        // deleted from the Destination Gas Configs, its key remains in the map and `destination_gas_configs` simply returns null.
        if (!destinationGasConfig) continue;

        destinationGasConfigs[gasConfigKey.toObject().destination] = {
          gasOracle: {
            tokenExchangeRate: destinationGasConfig
              .toObject()
              .exchange_rate.toString(),
            gasPrice: destinationGasConfig.toObject().gas_price.toString(),
          },
          gasOverhead: destinationGasConfig.toObject().gas_overhead.toString(),
        };
      }
    } catch {
      throw new Error(
        `Failed to found destination gas configs for IGP address: ${req.hookAddress}`,
      );
    }

    return {
      address: req.hookAddress,
      owner: owner,
      destinationGasConfigs: destinationGasConfigs,
    };
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    try {
      await this.aleoClient.getProgramMappingPlaintext(
        'hook_manager.aleo',
        'merkle_tree_hooks',
        req.hookAddress,
      );
    } catch {
      throw new Error(
        `Found no MerkleTreeHook for address: ${req.hookAddress}`,
      );
    }

    return {
      address: req.hookAddress,
    };
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(`TODO: implement`);
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const remoteRouters: {
      receiverDomainId: number;
      receiverAddress: string;
      gas: string;
    }[] = [];

    try {
      const routerLengthRes = await this.aleoClient.getProgramMappingValue(
        req.tokenAddress,
        'remote_router_length',
        'true',
      );

      for (let i = 0; i < parseInt(routerLengthRes); i++) {
        const routerKey = await this.aleoClient.getProgramMappingPlaintext(
          req.tokenAddress,
          'remote_router_iter',
          `${i}u32`,
        );

        const remoteRouterValue = await this.aleoClient.getProgramMappingValue(
          req.tokenAddress,
          'routes',
          routerKey,
        );

        if (!remoteRouterValue) continue;

        const remoteRouter = Plaintext.fromString(remoteRouterValue).toObject();

        remoteRouters.push({
          receiverDomainId: Number(remoteRouter['domain']),
          receiverAddress: remoteRouter['recipient'],
          gas: remoteRouter['gas'].toString(),
        });
      }
    } catch {
      throw new Error(
        `Failed to find remote routers for token address: ${req.tokenAddress}`,
      );
    }

    return {
      address: req.tokenAddress,
      remoteRouters,
    };
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(`TODO: implement`);
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(`TODO: implement`);
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<AleoTransaction> {
    return {
      programName: 'mailbox.aleo',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [`${req.domainId}u32`],
    };
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: 'mailbox.aleo',
      functionName: 'set_default_ism',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress],
    };
  }

  async getSetDefaultHookTransaction(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'mailbox.aleo',
      functionName: 'set_default_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress],
    };
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'mailbox.aleo',
      functionName: 'set_required_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress],
    };
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: 'mailbox.aleo',
      functionName: 'set_owner',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.newOwner],
    };
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`MerkleRootMultisigIsm is currently not supported on Aleo`);
  }

  async getCreateMessageIdMultisigIsmTransaction(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<AleoTransaction> {
    const MAXIMUM_VALIDATORS = 6;

    if (req.validators.length > MAXIMUM_VALIDATORS) {
      throw new Error(`maximum ${MAXIMUM_VALIDATORS} validators allowed`);
    }

    const validators = Array(MAXIMUM_VALIDATORS).fill({
      bytes: Array(20).fill(`0u8`),
    });

    req.validators
      .map((v) => ({
        bytes: [...Buffer.from(strip0x(v), 'hex')].map((b) => `${b}u8`),
      }))
      .forEach((v, i) => (validators[i] = v));

    return {
      programName: 'ism_manager.aleo',
      functionName: 'init_message_id_multisig',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        JSON.stringify(validators).replaceAll('"', ''),
        `${req.validators.length}u8`,
        `${req.threshold}u8`,
      ],
    };
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: 'ism_manager.aleo',
      functionName: 'init_domain_routing',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    return {
      programName: 'ism_manager.aleo',
      functionName: 'set_domain',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        req.ismAddress,
        `${req.route.domainId}u32`,
        req.route.ismAddress,
      ],
    };
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    return {
      programName: 'ism_manager.aleo',
      functionName: 'remove_domain',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress, `${req.domainId}u32`],
    };
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'transfer_routing_ism_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress, req.newOwner],
    };
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: 'ism_manager.aleo',
      functionName: 'init_noop',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getCreateMerkleTreeHookTransaction(
    _req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'init_merkle_tree',
      priorityFee: 0,
      privateFee: false,
      inputs: [Program.fromString(mailbox).address().to_string()],
    };
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    _req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'init_igp',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'transfer_igp_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress, req.newOwner],
    };
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'set_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        req.hookAddress,
        `${req.destinationGasConfig.remoteDomainId}u32`,
        `{gas_overhead:${req.destinationGasConfig.gasOverhead}u128,exchange_rate:${req.destinationGasConfig.gasOracle.tokenExchangeRate}u128,gas_price:${req.destinationGasConfig.gasOracle.gasPrice}u128}`,
      ],
    };
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<AleoTransaction> {
    const { localDomain } = await this.getMailbox({
      mailboxAddress: req.mailboxAddress,
    });

    return {
      programName: 'validator_announce.aleo',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        Program.fromString(mailbox).address().to_string(),
        `${localDomain}u32`,
      ],
    };
  }

  // ### GET WARP TXS ###

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetTokenOwnerTransaction(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: req.tokenAddress,
      functionName: 'set_owner',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.newOwner],
    };
  }

  async getSetTokenIsmTransaction(
    req: AltVM.ReqSetTokenIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: req.tokenAddress,
      functionName: 'set_custom_ism',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress],
    };
  }

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<AleoTransaction> {
    return {
      programName: req.tokenAddress,
      functionName: 'enroll_remote_router',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        `${req.remoteRouter.receiverDomainId}u32`,
        req.remoteRouter.receiverAddress,
        `${req.remoteRouter.gas}u128`,
      ],
    };
  }

  async getUnenrollRemoteRouterTransaction(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<AleoTransaction> {
    return {
      programName: req.tokenAddress,
      functionName: 'unroll_remote_router',
      priorityFee: 0,
      privateFee: false,
      inputs: [`${req.receiverDomainId}u32`],
    };
  }

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<AleoTransaction> {
    if (req.denom) {
      return {
        programName: 'token_registry.aleo',
        functionName: 'transfer_public',
        priorityFee: 0,
        privateFee: false,
        inputs: [req.denom, req.recipient, `${req.amount}u128`],
      };
    }

    return {
      programName: 'credits.aleo',
      functionName: 'transfer_public',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.recipient, `${req.amount}u64`],
    };
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }
}
