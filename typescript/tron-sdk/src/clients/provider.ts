import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { TronSDKOptions, TronSDKTransaction } from '../utils/types.js';

/**
 * TronProvider implements the IProvider interface for Tron.
 * Since Tron is EVM-compatible at the bytecode level, we can deploy
 * the same Solidity contracts. The main differences are:
 * - Address format (Base58Check vs hex)
 * - RPC interface (TronWeb vs ethers)
 * - Transaction structure
 */
export class TronProvider implements AltVM.IProvider<TronSDKTransaction> {
  protected tronWeb: TronWeb;
  protected rpcUrls: string[];
  protected chainId: number;

  static async connect(
    rpcUrls: string[],
    chainId: string | number,
    _extraParams?: Record<string, unknown>,
  ): Promise<TronProvider> {
    return new TronProvider({
      rpcUrls,
      chainId: typeof chainId === 'string' ? parseInt(chainId) : chainId,
    });
  }

  constructor(options: TronSDKOptions) {
    this.rpcUrls = options.rpcUrls;
    this.chainId = options.chainId;

    assert(this.rpcUrls.length > 0, 'At least one RPC URL required');

    // TronWeb requires fullHost or individual endpoints
    this.tronWeb = new TronWeb({
      fullHost: this.rpcUrls[0],
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.tronWeb.trx.getBlock('latest');
      return true;
    } catch {
      return false;
    }
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight(): Promise<number> {
    const block = await this.tronWeb.trx.getCurrentBlock();
    return block.block_header.raw_data.number;
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    // Convert Tron address to hex if needed for internal use
    const balance = await this.tronWeb.trx.getBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    // TRC20 total supply - would need contract address
    throw new Error('getTotalSupply requires TRC20 contract interaction');
  }

  /**
   * Get current energy price from the network.
   * Energy price is returned as a comma-separated string of "timestamp:price" pairs.
   * We take the latest (last) price.
   */
  async getEnergyPrice(): Promise<number> {
    const pricesStr = await this.tronWeb.trx.getEnergyPrices();
    // Format: "timestamp1:price1,timestamp2:price2,..."
    const pairs = pricesStr.split(',');
    const lastPair = pairs[pairs.length - 1];
    const price = parseInt(lastPair.split(':')[1]);
    assert(!isNaN(price), 'Failed to parse energy price from network');
    return price; // Price in sun per energy unit
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<TronSDKTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    // Get current energy price
    const energyPrice = await this.getEnergyPrice();

    // Estimate energy for the transaction
    let energyEstimate = BigInt(100_000); // Default estimate

    // If we have a transaction, try to estimate its energy
    if (req.transaction?.transaction) {
      try {
        // For contract calls, TronWeb returns energy_required
        const txData = req.transaction.transaction as {
          energy_required?: number;
        };
        if (txData.energy_required) {
          energyEstimate = BigInt(txData.energy_required);
        }
      } catch {
        // Use default estimate
      }
    }

    const fee = energyEstimate * BigInt(energyPrice);

    return {
      gasUnits: energyEstimate, // Energy units
      gasPrice: energyPrice, // Sun per energy unit
      fee, // Total fee in sun
    };
  }

  // Core contract queries - these interact with deployed Hyperlane contracts

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const contract = await this.tronWeb.contract().at(req.mailboxAddress);

    const [localDomain, defaultIsm, defaultHook, requiredHook, owner, nonce] =
      await Promise.all([
        contract.localDomain().call(),
        contract.defaultIsm().call(),
        contract.defaultHook().call(),
        contract.requiredHook().call(),
        contract.owner().call(),
        contract.nonce().call(),
      ]);

    return {
      address: req.mailboxAddress,
      localDomain: Number(localDomain),
      defaultIsm: this.tronWeb.address.fromHex(defaultIsm),
      defaultHook: this.tronWeb.address.fromHex(defaultHook),
      requiredHook: this.tronWeb.address.fromHex(requiredHook),
      owner: this.tronWeb.address.fromHex(owner),
      nonce: Number(nonce),
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    const contract = await this.tronWeb.contract().at(req.mailboxAddress);
    return contract.delivered(req.messageId).call();
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const contract = await this.tronWeb.contract().at(req.ismAddress);
    const moduleType = await contract.moduleType().call();

    // Map Solidity IInterchainSecurityModule.Types to AltVM.IsmType
    switch (Number(moduleType)) {
      case 1:
        return AltVM.IsmType.ROUTING;
      case 2:
        return AltVM.IsmType.AGGREGATION;
      case 4:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case 5:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      case 6:
        return AltVM.IsmType.TEST_ISM; // NULL ISM maps to TEST_ISM
      default:
        throw new Error(`Unknown ISM module type: ${moduleType}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const contract = await this.tronWeb.contract().at(req.ismAddress);
    const [validators, threshold] = await contract
      .validatorsAndThreshold('0x')
      .call();

    return {
      address: req.ismAddress,
      validators: validators.map((v: string) =>
        this.tronWeb.address.fromHex(v),
      ),
      threshold: Number(threshold),
    };
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    const contract = await this.tronWeb.contract().at(req.ismAddress);
    const [validators, threshold] = await contract
      .validatorsAndThreshold('0x')
      .call();

    return {
      address: req.ismAddress,
      validators: validators.map((v: string) =>
        this.tronWeb.address.fromHex(v),
      ),
      threshold: Number(threshold),
    };
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    const contract = await this.tronWeb.contract().at(req.ismAddress);
    const owner = await contract.owner().call();
    // Routes would need to be queried per-domain
    return {
      address: req.ismAddress,
      owner: this.tronWeb.address.fromHex(owner),
      routes: [], // Would need domain list to populate
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    return { address: req.ismAddress };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const contract = await this.tronWeb.contract().at(req.hookAddress);
    const hookType = await contract.hookType().call();

    switch (Number(hookType)) {
      case 1:
        return AltVM.HookType.ROUTING;
      case 2:
        return AltVM.HookType.AGGREGATION;
      case 3:
        return AltVM.HookType.MERKLE_TREE;
      case 4:
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      case 5:
        return AltVM.HookType.FALLBACK_ROUTING;
      case 7:
        return AltVM.HookType.PAUSABLE;
      case 8:
        return AltVM.HookType.PROTOCOL_FEE;
      default:
        throw new Error(`Unknown hook type: ${hookType}`);
    }
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const contract = await this.tronWeb.contract().at(req.hookAddress);
    const owner = await contract.owner().call();

    return {
      address: req.hookAddress,
      owner: this.tronWeb.address.fromHex(owner),
      destinationGasConfigs: {}, // Would need to query per-domain
    };
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    return { address: req.hookAddress };
  }

  async getNoopHook(req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    return { address: req.hookAddress };
  }

  // Warp route queries

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const contract = await this.tronWeb.contract().at(req.tokenAddress);

    const [name, symbol, decimals, mailbox, ism, hook, owner] =
      await Promise.all([
        contract.name().call(),
        contract.symbol().call(),
        contract.decimals().call(),
        contract.mailbox().call(),
        contract.interchainSecurityModule().call(),
        contract
          .hook()
          .call()
          .catch(() => null),
        contract.owner().call(),
      ]);

    // Determine token type by checking if it has a wrapped token
    let tokenType = AltVM.TokenType.synthetic;
    try {
      await contract.wrappedToken().call();
      tokenType = AltVM.TokenType.collateral;
    } catch {
      // No wrappedToken = synthetic
    }

    return {
      address: req.tokenAddress,
      name,
      symbol,
      denom: symbol, // Use symbol as denom
      decimals: Number(decimals),
      mailboxAddress: this.tronWeb.address.fromHex(mailbox),
      ismAddress: ism ? this.tronWeb.address.fromHex(ism) : '',
      hookAddress: hook ? this.tronWeb.address.fromHex(hook) : '',
      owner: this.tronWeb.address.fromHex(owner),
      tokenType,
    };
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const contract = await this.tronWeb.contract().at(req.tokenAddress);
    const domains = await contract.domains().call();

    const remoteRouters: AltVM.ResGetRemoteRouters['remoteRouters'] = [];
    for (const domain of domains) {
      const router = await contract.routers(domain).call();
      const gas = await contract.destinationGas(domain).call();
      remoteRouters.push({
        receiverDomainId: Number(domain),
        receiverAddress: router,
        gas: gas.toString(),
      });
    }

    return {
      address: req.tokenAddress,
      remoteRouters,
    };
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const contract = await this.tronWeb.contract().at(req.tokenAddress);
    const supply = await contract.totalSupply().call();
    return BigInt(supply);
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const contract = await this.tronWeb.contract().at(req.tokenAddress);
    const quote = await contract
      .quoteGasPayment(req.destinationDomainId)
      .call();
    return { denom: 'TRX', amount: BigInt(quote) };
  }

  // Transaction builders - these return unsigned transactions
  // The actual signing happens in TronSigner

  async getCreateMailboxTransaction(
    _req: AltVM.ReqCreateMailbox,
  ): Promise<TronSDKTransaction> {
    throw new Error(
      'Use TronSigner.createMailbox() for contract deployment on Tron',
    );
  }

  async getSetDefaultIsmTransaction(
    _req: AltVM.ReqSetDefaultIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetDefaultHookTransaction(
    _req: AltVM.ReqSetDefaultHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetRequiredHookTransaction(
    _req: AltVM.ReqSetRequiredHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetMailboxOwnerTransaction(
    _req: AltVM.ReqSetMailboxOwner,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateMessageIdMultisigIsmTransaction(
    _req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateMerkleTreeHookTransaction(
    _req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    _req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetDestinationGasConfigTransaction(
    _req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  // Warp route transactions

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for contract deployment');
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getSetTokenHookTransaction(
    _req: AltVM.ReqSetTokenHook,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getTransferTransaction(
    _req: AltVM.ReqTransfer,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<TronSDKTransaction> {
    throw new Error('Use TronSigner for transactions');
  }
}
