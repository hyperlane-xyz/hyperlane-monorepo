import { BigNumber } from 'bignumber.js';

import { AltVM, assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { ALEO_NULL_ADDRESS, formatAddress } from '../utils/helper.js';
import { AleoTransaction } from '../utils/types.js';

import { AleoBase } from './base.js';

export class AleoProvider extends AleoBase implements AltVM.IProvider {
  static async connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<AleoProvider> {
    return new AleoProvider(rpcUrls, chainId);
  }

  constructor(rpcUrls: string[], chainId: string | number) {
    super(rpcUrls, chainId);
  }

  protected getNewProgramSalt(n: number): string {
    const characters = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';

    for (let i = 0; i < n; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      result += characters[randomIndex];
    }

    return result;
  }

  protected getProgramSaltFromAddress(address: string): string {
    return (address.split('_').at(-1) || '').replaceAll('.aleo', '');
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
      const result = await this.aleoClient.getProgramMappingValue(
        'token_registry.aleo',
        'authorized_balances',
        this.getBalanceKey(req.address, req.denom),
      );

      if (result === null) {
        return 0n;
      }

      return this.Plaintext.fromString(result).toObject()['balance'];
    }

    const balance = await this.aleoClient.getPublicBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    if (!req.denom) {
      return 0n;
    }

    const result = await this.aleoClient.getProgramMappingValue(
      'token_registry.aleo',
      'registered_tokens',
      req.denom,
    );

    if (result === null) {
      return 0n;
    }

    return this.Plaintext.fromString(result).toObject()['max_supply'];
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<AleoTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const programManager = this.getProgramManager();
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
      defaultIsm: formatAddress(default_ism),
      defaultHook: formatAddress(default_hook),
      requiredHook: formatAddress(required_hook),
      nonce: nonce,
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    try {
      // Message key needs to be separated into [u128, u128] using Little Endian.
      const messageKey = this.bytes32ToU128String(req.messageId);

      const res = await this.aleoClient.getProgramMappingPlaintext(
        req.mailboxAddress,
        'deliveries',
        `{id:${messageKey}}`,
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

    return {
      address: req.ismAddress,
      validators: validators
        .map((v: any) => ensure0x(Buffer.from(v.bytes).toString('hex')))
        .filter((v: any) => v !== '0x0000000000000000000000000000000000000000'),
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
          `{hook:${req.hookAddress},index:${i}u32}`,
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

  async getNoopHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    try {
      const hook = await this.aleoClient.getProgramMappingPlaintext(
        'hook_manager.aleo',
        'hooks',
        req.hookAddress,
      );

      assert(
        hook.toObject() === 0,
        `hook of address ${req.hookAddress} is no noop hook`,
      );
    } catch {
      throw new Error(`Found no Noop Hook for address: ${req.hookAddress}`);
    }

    return {
      address: req.hookAddress,
    };
  }

  // ### QUERY WARP ###

  async getTokenMetadata(tokenId: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  }> {
    try {
      const tokenMetadata = await this.aleoClient.getProgramMappingPlaintext(
        'token_registry.aleo',
        'registered_tokens',
        tokenId,
      );

      const metadata = tokenMetadata.toObject();

      return {
        name: this.U128StringToString(
          `${tokenMetadata.toObject()['name'].toString()}u128`,
        ),
        symbol: this.U128StringToString(
          `${tokenMetadata.toObject()['symbol'].toString()}u128`,
        ),
        decimals: metadata['decimals'],
      };
    } catch {
      throw new Error(`Found no token for token id: ${tokenId}`);
    }
  }

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const token = {
      address: req.tokenAddress,
      owner: '',
      tokenType: AltVM.TokenType.native,
      mailboxAddress: '',
      ismAddress: '',
      denom: '',
      name: '',
      symbol: '',
      decimals: 0,
    };

    try {
      const tokenMetadata = await this.aleoClient.getProgramMappingPlaintext(
        req.tokenAddress,
        'token_metadata',
        'true',
      );

      token.owner = formatAddress(tokenMetadata.toObject().token_owner);
      token.ismAddress = formatAddress(tokenMetadata.toObject().ism || '');
      token.denom = tokenMetadata.toObject().token_id || '';

      if (token.denom) {
        const tokenRegistryMetadata = await this.getTokenMetadata(token.denom);

        token.name = tokenRegistryMetadata.name;
        token.symbol = tokenRegistryMetadata.symbol;
        token.decimals = tokenRegistryMetadata.decimals;
      }

      switch (tokenMetadata.toObject().token_type) {
        case 0:
          token.tokenType = AltVM.TokenType.native;
          break;
        case 1:
          token.tokenType = AltVM.TokenType.synthetic;
          break;
        case 2:
          token.tokenType = AltVM.TokenType.collateral;
          break;
      }
    } catch {
      throw new Error(`Found no token for address: ${req.tokenAddress}`);
    }

    try {
      const imports = await this.aleoClient.getProgramImportNames(
        req.tokenAddress,
      );
      token.mailboxAddress = imports.find((i) => i.includes('mailbox')) || '';
    } catch {
      throw new Error(
        `Found no imports for token address: ${req.tokenAddress}`,
      );
    }

    return token;
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
          'remote_routers',
          routerKey,
        );

        if (!remoteRouterValue) continue;

        const remoteRouter =
          this.Plaintext.fromString(remoteRouterValue).toObject();

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

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const metadata = await this.aleoClient.getProgramMappingPlaintext(
      req.tokenAddress,
      'token_metadata',
      'true',
    );

    switch (metadata.toObject()['token_type']) {
      case 0: {
        return this.getBalance({
          address: this.getAddressFromProgramId(req.tokenAddress),
          denom: '',
        });
      }
      case 1: {
        return this.getTotalSupply({
          denom: metadata.toObject()['token_id'],
        });
      }
      case 2: {
        return this.getBalance({
          address: this.getAddressFromProgramId(req.tokenAddress),
          denom: metadata.toObject()['token_id'],
        });
      }
      default: {
        throw new Error(
          `Unknown token type ${metadata.toObject()['token_type']}`,
        );
      }
    }
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const remoteRouterValue = await this.aleoClient.getProgramMappingValue(
      req.tokenAddress,
      'remote_routers',
      `${req.destinationDomainId}u32`,
    );

    if (!remoteRouterValue) {
      return {
        denom: '',
        amount: 0n,
      };
    }

    const gasLimit = new BigNumber(
      this.Plaintext.fromString(remoteRouterValue).toObject()['gas'],
    );

    const { mailboxAddress } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const mailbox = await this.getMailbox({
      mailboxAddress,
    });

    const quote = new BigNumber(0);

    for (const hookAddress of [mailbox.requiredHook, mailbox.defaultHook]) {
      try {
        const igp = await this.getInterchainGasPaymasterHook({
          hookAddress,
        });

        const config = igp.destinationGasConfigs[req.destinationDomainId];

        if (!config) {
          continue;
        }

        quote.plus(
          gasLimit
            .plus(config.gasOverhead)
            .multipliedBy(config.gasOracle.gasPrice)
            .multipliedBy(config.gasOracle.tokenExchangeRate)
            .dividedToIntegerBy(new BigNumber(10).exponentiatedBy(10)),
        );
      } catch {
        // if the hook is no IGP we assume a quote of zero
        quote.plus(0);
      }
    }

    return {
      denom: '',
      amount: BigInt(quote.toFixed(0)),
    };
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<AleoTransaction> {
    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [`${req.domainId}u32`],
      skipProof: this.skipProof,
    };
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress,
      functionName: 'set_default_ism',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress],
      skipProof: this.skipProof,
    };
  }

  async getSetDefaultHookTransaction(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress,
      functionName: 'set_default_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress],
      skipProof: this.skipProof,
    };
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress,
      functionName: 'set_required_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress],
      skipProof: this.skipProof,
    };
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress,
      functionName: 'set_owner',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.newOwner],
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
    };
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: 'ism_manager.aleo',
      functionName: 'transfer_routing_ism_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.ismAddress, req.newOwner],
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
    };
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'init_merkle_tree',
      priorityFee: 0,
      privateFee: false,
      inputs: [this.getAddressFromProgramId(req.mailboxAddress)],
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
    };
  }

  async getRemoveDestinationGasConfigTransaction(
    req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'remove_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress, `${req.remoteDomainId}u32`],
      skipProof: this.skipProof,
    };
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<AleoTransaction> {
    return {
      programName: 'hook_manager.aleo',
      functionName: 'init_noop',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
      skipProof: this.skipProof,
    };
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<AleoTransaction> {
    const { localDomain } = await this.getMailbox({
      mailboxAddress: req.mailboxAddress,
    });

    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        this.getAddressFromProgramId(req.mailboxAddress),
        `${localDomain}u32`,
      ],
      skipProof: this.skipProof,
    };
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<AleoTransaction> {
    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [`0u8`],
      skipProof: this.skipProof,
    };
  }

  async getCreateCollateralTokenTransaction(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<AleoTransaction> {
    const metadata = await this.getTokenMetadata(req.collateralDenom);

    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.collateralDenom, `${metadata.decimals}u8`],
      skipProof: this.skipProof,
    };
  }

  async getCreateSyntheticTokenTransaction(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<AleoTransaction> {
    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        this.stringToU128String(req.name),
        this.stringToU128String(req.denom),
        `${req.decimals}u8`,
        `${req.decimals}u8`,
      ],
      skipProof: this.skipProof,
    };
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
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
    };
  }

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<AleoTransaction> {
    const bytes = [...Buffer.from(req.remoteRouter.receiverAddress, 'hex')].map(
      (b) => `${b}u8`,
    );

    return {
      programName: req.tokenAddress,
      functionName: 'enroll_remote_router',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        `${req.remoteRouter.receiverDomainId}u32`,
        JSON.stringify(bytes).replaceAll('"', ''),
        `${req.remoteRouter.gas}u128`,
      ],
      skipProof: this.skipProof,
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
      skipProof: this.skipProof,
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
        skipProof: this.skipProof,
      };
    }

    return {
      programName: 'credits.aleo',
      functionName: 'transfer_public',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.recipient, `${req.amount}u64`],
      skipProof: this.skipProof,
    };
  }

  async getRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<AleoTransaction> {
    const { mailboxAddress } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const tokenMetadataValue = await this.aleoClient.getProgramMappingValue(
      req.tokenAddress,
      'token_metadata',
      'true',
    );

    if (!tokenMetadataValue) {
      throw new Error(`found no token metadata for ${req.tokenAddress}`);
    }

    const mailbox = await this.getMailbox({
      mailboxAddress: mailboxAddress,
    });

    const remoteRouterValue = await this.aleoClient.getProgramMappingValue(
      req.tokenAddress,
      'remote_routers',
      `${req.destinationDomainId}u32`,
    );

    if (!remoteRouterValue) {
      throw new Error(
        `found no remote router for destination domain id ${req.destinationDomainId}`,
      );
    }

    const recipient = this.bytes32ToU128String(req.recipient);

    const creditAllowance = Array(4).fill(
      `{spender:${ALEO_NULL_ADDRESS},amount:0u8}`,
    );

    const gasLimit = new BigNumber(req.gasLimit);
    const hooks = [
      req.customHookAddress || mailbox.defaultHook,
      mailbox.requiredHook,
    ];

    for (let i = 0; i < hooks.length; i++) {
      try {
        const igp = await this.getInterchainGasPaymasterHook({
          hookAddress: hooks[i],
        });

        const config = igp.destinationGasConfigs[req.destinationDomainId];

        if (!config) {
          continue;
        }

        const quote = gasLimit
          .plus(config.gasOverhead)
          .multipliedBy(config.gasOracle.gasPrice)
          .multipliedBy(config.gasOracle.tokenExchangeRate)
          .dividedToIntegerBy(new BigNumber(10).exponentiatedBy(10))
          .toFixed(0);

        creditAllowance[i] = `{spender:${hooks[i]},amount:${quote}u8}`;
      } catch {
        continue;
      }
    }

    if (req.customHookAddress) {
      const hookMetadata = Array(256).fill(`0u8`);

      if (req.customHookMetadata) {
        Buffer.from(req.customHookMetadata, 'hex').forEach((b, i) => {
          hookMetadata[i] = `${b}u8`;
        });
      }

      return {
        programName: req.tokenAddress,
        functionName: 'transfer_remote',
        priorityFee: 0,
        privateFee: false,
        inputs: [
          tokenMetadataValue,
          `{default_ism:${mailbox.defaultIsm || ALEO_NULL_ADDRESS},default_hook:${mailbox.defaultHook || ALEO_NULL_ADDRESS},required_hook:${mailbox.requiredHook || ALEO_NULL_ADDRESS}}`,
          remoteRouterValue,
          `${req.destinationDomainId}u8`,
          recipient,
          `${req.amount}u128`,
          JSON.stringify(creditAllowance).replaceAll('"', ''),
          req.customHookAddress,
          JSON.stringify(hookMetadata).replaceAll('"', ''),
        ],
        skipProof: this.skipProof,
      };
    }

    return {
      programName: req.tokenAddress,
      functionName: 'transfer_remote',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        tokenMetadataValue,
        `{default_ism:${mailbox.defaultIsm || ALEO_NULL_ADDRESS},default_hook:${mailbox.defaultHook || ALEO_NULL_ADDRESS},required_hook:${mailbox.requiredHook || ALEO_NULL_ADDRESS}}`,
        remoteRouterValue,
        `${req.destinationDomainId}u8`,
        recipient,
        `${req.amount}u128`,
        JSON.stringify(creditAllowance).replaceAll('"', ''),
      ],
      skipProof: this.skipProof,
    };
  }
}
