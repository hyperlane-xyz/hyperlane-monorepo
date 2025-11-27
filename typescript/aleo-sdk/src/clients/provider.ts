import { BigNumber } from 'bignumber.js';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import {
  ALEO_NATIVE_DENOM,
  ALEO_NULL_ADDRESS,
  arrayToPlaintext,
  fillArray,
  formatAddress,
} from '../utils/helper.js';
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
    if (req.denom && req.denom !== ALEO_NATIVE_DENOM) {
      const result = await this.queryMappingValue(
        'token_registry.aleo',
        'authorized_balances',
        this.getBalanceKey(req.address, req.denom),
        { balance: 0n },
      );

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
      { max_supply: 0n },
    );

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
    const {
      mailbox_owner,
      local_domain,
      default_ism,
      default_hook,
      required_hook,
      nonce,
    } = await this.queryMappingValue(req.mailboxAddress, 'mailbox', 'true');

    const hookManagerProgramId = req.mailboxAddress.replace(
      'mailbox',
      'hook_manager',
    );

    return {
      address: req.mailboxAddress,
      owner: mailbox_owner,
      localDomain: local_domain,
      defaultIsm: formatAddress(default_ism),
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
    const messageKey = this.bytes32ToU128String(req.messageId);

    const result = await this.queryMappingValue(
      req.mailboxAddress,
      'deliveries',
      `{id:${messageKey}}`,
      null,
    );

    if (result === null) {
      return false;
    }

    return Boolean(result.processor && result.block_number);
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const result = await this.queryMappingValue(
      'ism_manager.aleo',
      'isms',
      req.ismAddress,
    );

    switch (result) {
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
    const { validators, threshold } = await this.queryMappingValue(
      'ism_manager.aleo',
      'message_id_multisigs',
      req.ismAddress,
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
    const programId = 'ism_manager.aleo';

    const routes: { domainId: number; ismAddress: string }[] = [];

    const ismData = await this.queryMappingValue(
      programId,
      'domain_routing_isms',
      req.ismAddress,
    );
    const owner = ismData.ism_owner;

    const routeLengthRes = await this.queryMappingValue(
      programId,
      'route_length',
      req.ismAddress,
      0,
    );

    for (let i = 0; i < routeLengthRes; i++) {
      const routeKey = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'route_iter',
        `{ism:${req.ismAddress},index:${i}u32}`,
      );

      const ismAddress = await this.queryMappingValue(
        programId,
        'routes',
        routeKey.toString(),
        null,
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

    return {
      address: req.ismAddress,
      owner: owner,
      routes: routes,
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    await this.queryMappingValue('ism_manager.aleo', 'isms', req.ismAddress);

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const [programId, hookAddress] = req.hookAddress.split('/');

    const result = await this.queryMappingValue(
      programId,
      'hooks',
      hookAddress,
    );

    switch (result) {
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
    const [programId, hookAddress] = req.hookAddress.split('/');

    const destinationGasConfigs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    } = {};

    const igpData = await this.queryMappingValue(
      programId,
      'igps',
      hookAddress,
    );
    const owner = igpData.hook_owner;

    const gasConfigLength = await this.queryMappingValue(
      programId,
      'destination_gas_config_length',
      hookAddress,
      0,
    );

    for (let i = 0; i < gasConfigLength; i++) {
      const gasConfigKey = await this.aleoClient.getProgramMappingPlaintext(
        programId,
        'destination_gas_config_iter',
        `{hook:${hookAddress},index:${i}u32}`,
      );

      const destinationGasConfig = await this.queryMappingValue(
        programId,
        'destination_gas_configs',
        gasConfigKey.toString(),
        null,
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
    const [programId, hookAddress] = req.hookAddress.split('/');

    await this.queryMappingValue(programId, 'merkle_tree_hooks', hookAddress);

    return {
      address: req.hookAddress,
    };
  }

  async getNoopHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    const [programId, hookAddress] = req.hookAddress.split('/');

    const hook = await this.queryMappingValue(programId, 'hooks', hookAddress);
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
      name: this.U128StringToString(`${tokenMetadata['name'].toString()}u128`),
      symbol: this.U128StringToString(
        `${tokenMetadata['symbol'].toString()}u128`,
      ),
      decimals: tokenMetadata['decimals'],
    };
  }

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
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

    const imports = await this.aleoClient.getProgramImportNames(
      req.tokenAddress,
    );
    token.mailboxAddress = imports.find((i) => i.includes('mailbox')) || '';

    const tokenMetadata = await this.queryMappingValue(
      req.tokenAddress,
      'token_metadata',
      'true',
    );

    token.owner = formatAddress(tokenMetadata.token_owner);
    token.ismAddress = formatAddress(tokenMetadata.ism || '');
    token.hookAddress =
      tokenMetadata.hook === ALEO_NULL_ADDRESS
        ? ''
        : `${token.mailboxAddress.replace('mailbox', 'hook_manager')}/${tokenMetadata.hook}`;
    token.denom = tokenMetadata.token_id || '';

    if (token.denom) {
      const tokenRegistryMetadata = await this.getTokenMetadata(token.denom);

      token.name = tokenRegistryMetadata.name;
      token.symbol = tokenRegistryMetadata.symbol;
      token.decimals = tokenRegistryMetadata.decimals;
    }

    switch (tokenMetadata.token_type) {
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
    const metadata = await this.queryMappingValue(
      req.tokenAddress,
      'token_metadata',
      'true',
    );

    switch (metadata['token_type']) {
      case 0: {
        return this.getBalance({
          address: this.getAddressFromProgramId(req.tokenAddress),
          denom: '',
        });
      }
      case 1: {
        return this.getTotalSupply({
          denom: metadata['token_id'],
        });
      }
      case 2: {
        return this.getBalance({
          address: this.getAddressFromProgramId(req.tokenAddress),
          denom: metadata['token_id'],
        });
      }
      default: {
        throw new Error(`Unknown token type ${metadata['token_type']}`);
      }
    }
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const remoteRouter = await this.queryMappingValue(
      req.tokenAddress,
      'remote_routers',
      `${req.destinationDomainId}u32`,
      null,
    );

    if (!remoteRouter) {
      return {
        denom: ALEO_NATIVE_DENOM,
        amount: 0n,
      };
    }

    let gasLimit = new BigNumber(remoteRouter['gas']);

    if (req.customHookAddress && req.customHookMetadata) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      gasLimit = new BigNumber(
        this.U128.fromBytesLe(Uint8Array.from(metadataBytes.slice(0, 16)))
          .toString()
          .replace('u128', ''),
      );
    }

    const { mailboxAddress } = await this.getToken({
      tokenAddress: req.tokenAddress,
    });

    const mailbox = await this.getMailbox({
      mailboxAddress,
    });

    let quote = new BigNumber(0);

    const hooks = [
      req.customHookAddress || mailbox.defaultHook,
      mailbox.requiredHook,
    ];

    for (const hookAddress of hooks) {
      if (!hookAddress) {
        continue;
      }

      try {
        const igp = await this.getInterchainGasPaymasterHook({
          hookAddress,
        });

        const config = igp.destinationGasConfigs[req.destinationDomainId];

        if (!config) {
          continue;
        }

        quote = quote.plus(
          gasLimit
            .plus(config.gasOverhead)
            .multipliedBy(config.gasOracle.gasPrice)
            .multipliedBy(config.gasOracle.tokenExchangeRate)
            .dividedToIntegerBy(new BigNumber(10).exponentiatedBy(10)),
        );
      } catch {
        continue;
      }
    }

    return {
      denom: ALEO_NATIVE_DENOM,
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
      inputs: [req.hookAddress.split('/')[1]],
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
      inputs: [req.hookAddress.split('/')[1]],
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
      programName: 'ism_manager.aleo',
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
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress.replace('mailbox', 'hook_manager'),
      functionName: 'init_merkle_tree',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        this.getAddressFromProgramId(
          req.mailboxAddress.replace('mailbox', 'dispatch_proxy'),
        ),
      ],
    };
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress.replace('mailbox', 'hook_manager'),
      functionName: 'init_igp',
      priorityFee: 0,
      privateFee: false,
      inputs: [],
    };
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<AleoTransaction> {
    const [programId, hookAddress] = req.hookAddress.split('/');

    return {
      programName: programId,
      functionName: 'transfer_igp_ownership',
      priorityFee: 0,
      privateFee: false,
      inputs: [hookAddress, req.newOwner],
    };
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<AleoTransaction> {
    const [programId, hookAddress] = req.hookAddress.split('/');

    return {
      programName: programId,
      functionName: 'set_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        hookAddress,
        `${req.destinationGasConfig.remoteDomainId}u32`,
        `{gas_overhead:${req.destinationGasConfig.gasOverhead}u128,exchange_rate:${req.destinationGasConfig.gasOracle.tokenExchangeRate}u128,gas_price:${req.destinationGasConfig.gasOracle.gasPrice}u128}`,
      ],
    };
  }

  async getRemoveDestinationGasConfigTransaction(
    req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<AleoTransaction> {
    const [programId, hookAddress] = req.hookAddress.split('/');

    return {
      programName: programId,
      functionName: 'remove_destination_gas_config',
      priorityFee: 0,
      privateFee: false,
      inputs: [hookAddress, `${req.remoteDomainId}u32`],
    };
  }

  async getCreateNoopHookTransaction(
    req: AltVM.ReqCreateNoopHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.mailboxAddress.replace('mailbox', 'hook_manager'),
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

    return {
      programName: '',
      functionName: 'init',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        this.getAddressFromProgramId(req.mailboxAddress),
        `${localDomain}u32`,
      ],
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
        this.stringToU128String(req.name),
        this.stringToU128String(req.denom),
        `${req.decimals}u8`,
        `${req.decimals}u8`,
      ],
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

  async getSetTokenHookTransaction(
    req: AltVM.ReqSetTokenHook,
  ): Promise<AleoTransaction> {
    return {
      programName: req.tokenAddress,
      functionName: 'set_custom_hook',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.hookAddress.split('/')[1]],
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
      programName: req.tokenAddress,
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
      `{spender:${ALEO_NULL_ADDRESS},amount:0u64}`,
    );

    let gasLimit = new BigNumber(req.gasLimit);

    if (req.customHookAddress && req.customHookMetadata) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      gasLimit = new BigNumber(
        this.U128.fromBytesLe(Uint8Array.from(metadataBytes.slice(0, 16)))
          .toString()
          .replace('u128', ''),
      );
    }

    const mailbox = await this.getMailbox({
      mailboxAddress: mailboxAddress,
    });

    const hooks = [
      req.customHookAddress || mailbox.defaultHook,
      mailbox.requiredHook,
    ];

    let totalQuote = new BigNumber(0);

    for (let i = 0; i < hooks.length; i++) {
      if (!hooks[i]) {
        continue;
      }

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

        creditAllowance[i] =
          `{spender:${hooks[i].split('/')[1]},amount:${quote}u64}`;
        totalQuote = totalQuote.plus(quote);
      } catch {
        continue;
      }
    }

    assert(
      totalQuote.lte(req.maxFee.amount),
      `total quote ${totalQuote.toFixed(0)} is bigger than max fee ${req.maxFee.amount}`,
    );

    const mailboxValue = `{
      default_ism:${mailbox.defaultIsm || ALEO_NULL_ADDRESS},
      default_hook:${mailbox.defaultHook ? mailbox.defaultHook.split('/')[1] : ALEO_NULL_ADDRESS},
      required_hook:${mailbox.requiredHook ? mailbox.requiredHook.split('/')[1] : ALEO_NULL_ADDRESS}
    }`;

    if (req.customHookAddress) {
      const metadataBytes: number[] = fillArray(
        [...Buffer.from(strip0x(req.customHookMetadata || ''), 'hex')],
        64,
        0,
      );
      const gasLimit = this.U128.fromBytesLe(
        Uint8Array.from(metadataBytes.slice(0, 16)),
      ).toString();

      const hookMetadata = `{gas_limit:${gasLimit},extra_data:[${metadataBytes.map((b) => `${b}u8`).join(',')}]}`;

      return {
        programName: req.tokenAddress,
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
          req.customHookAddress.split('/')[1],
          hookMetadata,
        ],
      };
    }

    return {
      programName: req.tokenAddress,
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
