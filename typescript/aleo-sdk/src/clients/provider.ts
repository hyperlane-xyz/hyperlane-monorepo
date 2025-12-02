import { Plaintext, U128 } from '@provablehq/sdk/mainnet.js';
import { BigNumber } from 'bignumber.js';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import {
  ALEO_NATIVE_DENOM,
  ALEO_NULL_ADDRESS,
  U128ToString,
  arrayToPlaintext,
  bytes32ToU128String,
  fillArray,
  formatAddress,
  fromAleoAddress,
  getAddressFromProgramId,
  getBalanceKey,
  getProgramIdFromSuffix,
  getProgramSuffix,
  stringToU128,
  toAleoAddress,
} from '../utils/helper.js';
import {
  AleoHookType,
  AleoIsmType,
  AleoTokenType,
  AleoTransaction,
} from '../utils/types.js';

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

  protected generateSuffix(n: number): string {
    const characters = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';

    for (let i = 0; i < n; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      result += characters[randomIndex];
    }

    return result;
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
    if (req.denom && req.denom !== ALEO_NATIVE_DENOM) {
      const result = await this.queryMappingValue(
        'token_registry.aleo',
        'authorized_balances',
        getBalanceKey(req.address, req.denom),
      );

      if (!result) {
        return 0n;
      }

      return result['balance'];
    }

    const balance = await this.aleoClient.getPublicBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    if (!req.denom) {
      return 0n;
    }

    const result = await this.queryMappingValue(
      'token_registry.aleo',
      'registered_tokens',
      req.denom,
    );

    if (!result) {
      0n;
    }

    return result['max_supply'];
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<AleoTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const programManager = this.getProgramManager();
    const fee = await programManager.estimateExecutionFee({
      programName: req.transaction.programName,
      functionName: req.transaction.functionName,
    });

    return {
      fee,
      gasUnits: 0n,
      gasPrice: 0,
    };
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const { programId } = fromAleoAddress(req.mailboxAddress);

    const {
      mailbox_owner,
      local_domain,
      default_ism,
      default_hook,
      required_hook,
      nonce,
    } = await this.queryMappingValue(programId, 'mailbox', 'true');

    const hookManagerProgramId = getProgramIdFromSuffix(
      'hook_manager',
      getProgramSuffix(programId),
    );

    return {
      address: req.mailboxAddress,
      owner: mailbox_owner,
      localDomain: local_domain,
      defaultIsm:
        default_ism === ALEO_NULL_ADDRESS
          ? ''
          : `${this.ismManager}/${default_ism}`,
      defaultHook:
        default_hook === ALEO_NULL_ADDRESS
          ? ''
          : `${hookManagerProgramId}/${default_hook}`,
      requiredHook:
        required_hook === ALEO_NULL_ADDRESS
          ? ''
          : `${hookManagerProgramId}/${required_hook}`,
      nonce: nonce,
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    const messageKey = bytes32ToU128String(req.messageId);

    const result = await this.queryMappingValue(
      fromAleoAddress(req.mailboxAddress).programId,
      'deliveries',
      `{id:${messageKey}}`,
    );

    return !!result;
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    const result = await this.queryMappingValue(programId, 'isms', address);

    switch (result) {
      case AleoIsmType.TEST_ISM:
        return AltVM.IsmType.TEST_ISM;
      case AleoIsmType.ROUTING:
        return AltVM.IsmType.ROUTING;
      case AleoIsmType.MERKLE_ROOT_MULTISIG:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case AleoIsmType.MESSAGE_ID_MULTISIG:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      default:
        throw new Error(`Unknown ISM type for address: ${req.ismAddress}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    const { validators, threshold } = await this.queryMappingValue(
      programId,
      'message_id_multisigs',
      address,
    );

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
    const { programId, address } = fromAleoAddress(req.ismAddress);

    const routes: { domainId: number; ismAddress: string }[] = [];

    const ismData = await this.queryMappingValue(
      programId,
      'domain_routing_isms',
      address,
    );
    const owner = ismData.ism_owner;

    const routeLengthRes = await this.queryMappingValue(
      programId,
      'route_length',
      address,
    );

    for (let i = 0; i < (routeLengthRes || 0); i++) {
      const routeKey = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'route_iter',
        `{ism:${address},index:${i}u32}`,
      );

      const ismAddress = await this.queryMappingValue(
        programId,
        'routes',
        routeKey.toString(),
      );

      // This is necessary because `route_iter` maintains keys for all route entries,
      // including those from domains that have already been removed. When a domain is
      // deleted from the Routing ISM, its key remains in the map and `routes` simply returns null.
      if (!ismAddress) continue;

      routes.push({
        ismAddress: `${this.ismManager}/${ismAddress}`,
        domainId: routeKey.toObject().domain,
      });
    }

    return {
      address: req.ismAddress,
      owner: owner,
      routes: routes,
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    await this.queryMappingValue(programId, 'isms', address);

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    const result = await this.queryMappingValue(programId, 'hooks', address);

    switch (result) {
      case AleoHookType.CUSTOM:
        return AltVM.HookType.CUSTOM;
      case AleoHookType.MERKLE_TREE:
        return AltVM.HookType.MERKLE_TREE;
      case AleoHookType.INTERCHAIN_GAS_PAYMASTER:
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      case AleoHookType.PAUSABLE:
        return AltVM.HookType.PAUSABLE;
      default:
        throw new Error(`Unknown Hook type for address: ${req.hookAddress}`);
    }
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    const destinationGasConfigs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    } = {};

    const igpData = await this.queryMappingValue(programId, 'igps', address);
    const owner = igpData.hook_owner;

    const gasConfigLength = await this.queryMappingValue(
      programId,
      'destination_gas_config_length',
      address,
    );

    for (let i = 0; i < (gasConfigLength || 0); i++) {
      const gasConfigKey = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'destination_gas_config_iter',
        `{hook:${address},index:${i}u32}`,
      );

      const destinationGasConfig = await this.queryMappingValue(
        programId,
        'destination_gas_configs',
        gasConfigKey.toString(),
      );

      // This is necessary because `destination_gas_config_iter` maintains keys for all destination domain entries,
      // including those from domains that have already been removed. When a domain is
      // deleted from the Destination Gas Configs, its key remains in the map and `destination_gas_configs` simply returns null.
      if (!destinationGasConfig) continue;

      destinationGasConfigs[gasConfigKey.toObject().destination] = {
        gasOracle: {
          tokenExchangeRate: destinationGasConfig.exchange_rate.toString(),
          gasPrice: destinationGasConfig.gas_price.toString(),
        },
        gasOverhead: destinationGasConfig.gas_overhead.toString(),
      };
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
    const { programId, address } = fromAleoAddress(req.hookAddress);

    await this.queryMappingValue(programId, 'merkle_tree_hooks', address);

    return {
      address: req.hookAddress,
    };
  }

  async getNoopHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    const hook = await this.queryMappingValue(programId, 'hooks', address);
    assert(hook === 0, `hook of address ${req.hookAddress} is no noop hook`);

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
    const tokenMetadata = await this.queryMappingValue(
      'token_registry.aleo',
      'registered_tokens',
      tokenId,
    );

    return {
      name: U128ToString(tokenMetadata['name']),
      symbol: U128ToString(tokenMetadata['symbol']),
      decimals: tokenMetadata['decimals'],
    };
  }

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const { programId } = fromAleoAddress(req.tokenAddress);

    const token = {
      address: req.tokenAddress,
      owner: '',
      tokenType: AltVM.TokenType.native,
      mailboxAddress: '',
      ismAddress: '',
      hookAddress: '',
      denom: '',
      name: '',
      symbol: '',
      decimals: 0,
    };

    const imports = await this.aleoClient.getProgramImportNames(programId);
    const mailboxProgramId = imports.find((i) => i.includes('mailbox')) || '';
    assert(
      mailboxProgramId,
      `could not find mailbox program id on token ${req.tokenAddress}`,
    );
    token.mailboxAddress = toAleoAddress(mailboxProgramId);

    const tokenMetadata = await this.queryMappingValue(
      programId,
      'app_metadata',
      'true',
    );

    token.owner = formatAddress(tokenMetadata.token_owner);
    token.ismAddress =
      tokenMetadata.ism === ALEO_NULL_ADDRESS
        ? ''
        : `${this.ismManager}/${tokenMetadata.ism}`;
    token.hookAddress =
      tokenMetadata.hook === ALEO_NULL_ADDRESS
        ? ''
        : `${getProgramIdFromSuffix('hook_manager', getProgramSuffix(mailboxProgramId))}/${tokenMetadata.hook}`;
    token.denom = tokenMetadata.token_id || '';

    if (token.denom) {
      const tokenRegistryMetadata = await this.getTokenMetadata(token.denom);

      token.name = tokenRegistryMetadata.name;
      token.symbol = tokenRegistryMetadata.symbol;
      token.decimals = tokenRegistryMetadata.decimals;
    }

    switch (tokenMetadata.token_type) {
      case AleoTokenType.NATIVE:
        token.tokenType = AltVM.TokenType.native;
        break;
      case AleoTokenType.SYNTHETIC:
        token.tokenType = AltVM.TokenType.synthetic;
        break;
      case AleoTokenType.COLLATERAL:
        token.tokenType = AltVM.TokenType.collateral;
        break;
    }

    return token;
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const { programId } = fromAleoAddress(req.tokenAddress);

    const remoteRouters: {
      receiverDomainId: number;
      receiverAddress: string;
      gas: string;
    }[] = [];

    try {
      const routerLengthRes = await this.aleoClient.getProgramMappingValue(
        programId,
        'remote_router_length',
        'true',
      );

      for (let i = 0; i < parseInt(routerLengthRes); i++) {
        const routerKey = await this.aleoClient.getProgramMappingPlaintext(
          programId,
          'remote_router_iter',
          `${i}u32`,
        );

        const remoteRouterValue = await this.aleoClient.getProgramMappingValue(
          programId,
          'remote_routers',
          routerKey,
        );

        if (!remoteRouterValue) continue;

        const remoteRouter = Plaintext.fromString(remoteRouterValue).toObject();

        if (
          remoteRouters.find(
            (r) => r.receiverDomainId === Number(remoteRouter['domain']),
          )
        ) {
          continue;
        }

        remoteRouters.push({
          receiverDomainId: Number(remoteRouter['domain']),
          receiverAddress: ensure0x(
            Buffer.from(remoteRouter['recipient']).toString('hex'),
          ),
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
    const { programId } = fromAleoAddress(req.tokenAddress);

    const metadata = await this.queryMappingValue(
      req.tokenAddress,
      'app_metadata',
      'true',
    );

    switch (metadata['token_type']) {
      case AleoTokenType.NATIVE: {
        return this.getBalance({
          address: getAddressFromProgramId(programId),
          denom: '',
        });
      }
      case AleoTokenType.SYNTHETIC: {
        return this.getTotalSupply({
          denom: metadata['token_id'],
        });
      }
      case AleoTokenType.COLLATERAL: {
        return this.getBalance({
          address: getAddressFromProgramId(programId),
          denom: metadata['token_id'],
        });
      }
      default: {
        throw new Error(`Unknown token type ${metadata['token_type']}`);
      }
    }
  }

  private async getQuotes(
    gasLimit: string,
    destinationDomainId: number,
    hooks: string[],
  ): Promise<{
    total_quote: string;
    quotes: { spender: string; quote: string }[];
  }> {
    let total_quote = new BigNumber(0);
    const quotes = [];

    for (const hookAddress of hooks) {
      if (!hookAddress) {
        continue;
      }

      try {
        const { programId, address } = fromAleoAddress(hookAddress);

        const config = await this.queryMappingValue(
          programId,
          'destination_gas_configs',
          `{igp:${address},destination:${destinationDomainId}u32}`,
        );

        if (!config) {
          continue;
        }

        const quote = new BigNumber(gasLimit)
          .plus(config.gas_overhead.toString())
          .multipliedBy(config.gas_price.toString())
          .multipliedBy(config.exchange_rate.toString())
          .dividedToIntegerBy(new BigNumber(10).exponentiatedBy(10))
          .toFixed(0);

        total_quote = total_quote.plus(quote);

        quotes.push({
          spender: address,
          quote,
        });
      } catch {
        continue;
      }
    }

    return {
      total_quote: total_quote.toFixed(0),
      quotes,
    };
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const { programId } = fromAleoAddress(req.tokenAddress);

    const remoteRouter = await this.queryMappingValue(
      programId,
      'remote_routers',
      `${req.destinationDomainId}u32`,
    );

    if (!remoteRouter) {
      return {
        denom: ALEO_NATIVE_DENOM,
        amount: 0n,
      };
    }

    let gasLimit = remoteRouter['gas'] as string;

    if (req.customHookAddress && req.customHookMetadata) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      gasLimit = U128.fromBytesLe(Uint8Array.from(metadataBytes.slice(0, 16)))
        .toString()
        .replace('u128', '');
    }

    const { mailboxAddress } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const mailbox = await this.getMailbox({
      mailboxAddress,
    });

    const { total_quote } = await this.getQuotes(
      gasLimit,
      req.destinationDomainId,
      [req.customHookAddress || mailbox.defaultHook, mailbox.requiredHook],
    );

    return {
      denom: ALEO_NATIVE_DENOM,
      amount: BigInt(total_quote),
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
    };
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.mailboxAddress).programId,
      functionName: 'set_default_ism',
      priorityFee: 0,
      privateFee: false,
      inputs: [fromAleoAddress(req.ismAddress).address],
    };
  }

  async getSetDefaultHookTransaction(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.mailboxAddress).programId,
      functionName: 'set_default_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [fromAleoAddress(req.hookAddress).address],
    };
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.mailboxAddress).programId,
      functionName: 'set_required_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [fromAleoAddress(req.hookAddress).address],
    };
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.mailboxAddress).programId,
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

    const validators = fillArray(
      req.validators.map((v) => ({
        bytes: [...Buffer.from(strip0x(v), 'hex')].map((b) => `${b}u8`),
      })),
      MAXIMUM_VALIDATORS,
      {
        bytes: Array(20).fill(`0u8`),
      },
    );

    return {
      programName: this.ismManager,
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
      programName: this.ismManager,
      functionName: 'init_domain_routing',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    return {
      programName: programId,
      functionName: 'set_domain',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        address,
        `${req.route.domainId}u32`,
        fromAleoAddress(req.route.ismAddress).address,
      ],
    };
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    return {
      programName: programId,
      functionName: 'remove_domain',
      priorityFee: 0,
      privateFee: false,
      inputs: [address, `${req.domainId}u32`],
    };
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.ismAddress);

    return {
      programName: programId,
      functionName: 'transfer_routing_ism_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [address, req.newOwner],
    };
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<AleoTransaction> {
    return {
      programName: this.ismManager,
      functionName: 'init_noop',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<AleoTransaction> {
    const { programId } = fromAleoAddress(req.mailboxAddress);
    const suffix = getProgramSuffix(programId);

    return {
      programName: getProgramIdFromSuffix('hook_manager', suffix),
      functionName: 'init_merkle_tree',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        getAddressFromProgramId(
          getProgramIdFromSuffix('dispatch_proxy', suffix),
        ),
      ],
    };
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<AleoTransaction> {
    const { programId } = fromAleoAddress(req.mailboxAddress);

    return {
      programName: getProgramIdFromSuffix(
        'hook_manager',
        getProgramSuffix(programId),
      ),
      functionName: 'init_igp',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    return {
      programName: programId,
      functionName: 'transfer_igp_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [address, req.newOwner],
    };
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    return {
      programName: programId,
      functionName: 'set_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        address,
        `${req.destinationGasConfig.remoteDomainId}u32`,
        `{gas_overhead:${req.destinationGasConfig.gasOverhead}u128,exchange_rate:${req.destinationGasConfig.gasOracle.tokenExchangeRate}u128,gas_price:${req.destinationGasConfig.gasOracle.gasPrice}u128}`,
      ],
    };
  }

  async getRemoveDestinationGasConfigTransaction(
    req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<AleoTransaction> {
    const { programId, address } = fromAleoAddress(req.hookAddress);

    return {
      programName: programId,
      functionName: 'remove_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [address, `${req.remoteDomainId}u32`],
    };
  }

  async getCreateNoopHookTransaction(
    req: AltVM.ReqCreateNoopHook,
  ): Promise<AleoTransaction> {
    const { programId } = fromAleoAddress(req.mailboxAddress);

    return {
      programName: getProgramIdFromSuffix(
        'hook_manager',
        getProgramSuffix(programId),
      ),
      functionName: 'init_noop',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<AleoTransaction> {
    const { localDomain } = await this.getMailbox({
      mailboxAddress: req.mailboxAddress,
    });

    const { address } = fromAleoAddress(req.mailboxAddress);

    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [address, `${localDomain}u32`],
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
        `${stringToU128(req.name).toString()}u128`,
        `${stringToU128(req.denom).toString()}u128`,
        `${req.decimals}u8`,
        `${req.decimals}u8`,
      ],
    };
  }

  async getSetTokenOwnerTransaction(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.tokenAddress).programId,
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
      programName: fromAleoAddress(req.tokenAddress).programId,
      functionName: 'set_custom_ism',
      priorityFee: 0,
      privateFee: false,
      inputs: [fromAleoAddress(req.ismAddress).address],
    };
  }

  async getSetTokenHookTransaction(
    req: AltVM.ReqSetTokenHook,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.tokenAddress).programId,
      functionName: 'set_custom_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [fromAleoAddress(req.hookAddress).address],
    };
  }

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<AleoTransaction> {
    const bytes = fillArray(
      [...Buffer.from(strip0x(req.remoteRouter.receiverAddress), 'hex')].map(
        (b) => `${b}u8`,
      ),
      32,
      `0u8`,
    );

    return {
      programName: fromAleoAddress(req.tokenAddress).programId,
      functionName: 'enroll_remote_router',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        `${req.remoteRouter.receiverDomainId}u32`,
        arrayToPlaintext(bytes),
        `${req.remoteRouter.gas}u128`,
      ],
    };
  }

  async getUnenrollRemoteRouterTransaction(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<AleoTransaction> {
    return {
      programName: fromAleoAddress(req.tokenAddress).programId,
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
    req: AltVM.ReqRemoteTransfer,
  ): Promise<AleoTransaction> {
    const { mailboxAddress } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const { programId } = fromAleoAddress(req.tokenAddress);

    const tokenMetadataValue = await this.aleoClient.getProgramMappingValue(
      programId,
      'app_metadata',
      'true',
    );

    if (!tokenMetadataValue) {
      throw new Error(`found no token metadata for ${req.tokenAddress}`);
    }

    const remoteRouterValue = await this.aleoClient.getProgramMappingValue(
      programId,
      'remote_routers',
      `${req.destinationDomainId}u32`,
    );

    if (!remoteRouterValue) {
      throw new Error(
        `found no remote router for destination domain id ${req.destinationDomainId}`,
      );
    }

    const recipient = bytes32ToU128String(req.recipient);

    const creditAllowance = Array(4).fill(
      `{spender:${ALEO_NULL_ADDRESS},amount:0u64}`,
    );

    let gasLimit = req.gasLimit;

    if (req.customHookAddress && req.customHookMetadata) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      gasLimit = U128.fromBytesLe(Uint8Array.from(metadataBytes.slice(0, 16)))
        .toString()
        .replace('u128', '');
    }

    const mailbox = await this.getMailbox({
      mailboxAddress,
    });

    const { total_quote, quotes } = await this.getQuotes(
      gasLimit,
      req.destinationDomainId,
      [req.customHookAddress || mailbox.defaultHook, mailbox.requiredHook],
    );

    assert(
      new BigNumber(total_quote).lte(req.maxFee.amount),
      `total quote ${total_quote} is bigger than max fee ${req.maxFee.amount}`,
    );

    for (let i = 0; i < quotes.length; i++) {
      creditAllowance[i] =
        `{spender:${quotes[i].spender},amount:${quotes[i].quote}u64}`;
    }

    const mailboxValue = `{
      default_hook:${mailbox.defaultHook ? fromAleoAddress(mailbox.defaultHook).address : ALEO_NULL_ADDRESS},
      required_hook:${mailbox.requiredHook ? fromAleoAddress(mailbox.requiredHook).address : ALEO_NULL_ADDRESS}
    }`;

    if (req.customHookAddress) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      const gasLimit = U128.fromBytesLe(
        Uint8Array.from(metadataBytes.slice(0, 16)),
      ).toString();

      const hookMetadata = `{gas_limit:${gasLimit},extra_data:[${metadataBytes.map((b) => `${b}u8`).join(',')}]}`;

      return {
        programName: programId,
        functionName: 'transfer_remote_with_hook',
        priorityFee: 0,
        privateFee: false,
        inputs: [
          tokenMetadataValue,
          mailboxValue,
          remoteRouterValue,
          `${req.destinationDomainId}u32`,
          recipient,
          `${req.amount}u64`,
          arrayToPlaintext(creditAllowance),
          fromAleoAddress(req.customHookAddress).address,
          hookMetadata,
        ],
      };
    }

    return {
      programName: programId,
      functionName: 'transfer_remote',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        tokenMetadataValue,
        mailboxValue,
        remoteRouterValue,
        `${req.destinationDomainId}u32`,
        recipient,
        `${req.amount}u64`,
        arrayToPlaintext(creditAllowance),
      ],
    };
  }
}
