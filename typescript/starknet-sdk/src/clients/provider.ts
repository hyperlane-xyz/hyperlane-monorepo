import {
  AccountInterface,
  CairoOption,
  CairoOptionVariant,
  Contract,
  RawArgsArray,
  RpcProvider,
  hash,
  shortString,
} from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';
import {
  addressToBytes32,
  assert,
  ensure0x,
  isNullish,
} from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  callContract,
  getFeeTokenAddress,
  getOnChainStarknetContract,
  getStarknetContract,
  isProbeMiss,
  normalizeRoutersAddress,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
  toBigInt,
  toNumber,
} from '../contracts.js';
import { isMessageDelivered } from '../mailbox/mailbox-query.js';
import { StarknetAnnotatedTx } from '../types.js';

let tokenTypeByClassHash: Map<string, AltVM.TokenType> | undefined;

function getTokenTypeByClassHash(): Map<string, AltVM.TokenType> {
  if (tokenTypeByClassHash) {
    return tokenTypeByClassHash;
  }

  const entries = [
    [
      hash.computeContractClassHash(
        getCompiledContract(StarknetContractName.HYP_ERC20, ContractType.TOKEN),
      ),
      AltVM.TokenType.synthetic,
    ],
    [
      hash.computeContractClassHash(
        getCompiledContract(
          StarknetContractName.HYP_ERC20_COLLATERAL,
          ContractType.TOKEN,
        ),
      ),
      AltVM.TokenType.collateral,
    ],
    [
      hash.computeContractClassHash(
        getCompiledContract(
          StarknetContractName.HYP_NATIVE,
          ContractType.TOKEN,
        ),
      ),
      AltVM.TokenType.native,
    ],
  ] satisfies ReadonlyArray<readonly [string, AltVM.TokenType]>;

  tokenTypeByClassHash = new Map(
    entries.map(([classHash, tokenType]): [string, AltVM.TokenType] => [
      BigInt(classHash).toString(),
      tokenType,
    ]),
  );

  return tokenTypeByClassHash;
}

export class StarknetProvider implements AltVM.IProvider<StarknetAnnotatedTx> {
  static connect(
    rpcUrls: string[],
    _chainId: string | number,
    extraParams?: { metadata?: ChainMetadataForAltVM },
  ): StarknetProvider {
    assert(extraParams?.metadata, 'metadata missing for Starknet provider');
    const metadata = extraParams.metadata;
    assert(rpcUrls.length > 0, 'at least one rpc url is required');

    const blockTime = metadata.blocks?.estimateBlockTime;
    const transactionRetryIntervalFallback =
      !isNullish(blockTime) && blockTime <= 1 ? 1000 : undefined;

    const provider = new RpcProvider({
      nodeUrl: rpcUrls[0],
      transactionRetryIntervalFallback,
    });
    return new StarknetProvider(provider, metadata, rpcUrls);
  }

  protected constructor(
    protected readonly provider: RpcProvider,
    protected readonly metadata: ChainMetadataForAltVM,
    protected readonly rpcUrls: string[],
  ) {}

  getRawProvider(): RpcProvider {
    return this.provider;
  }

  protected withContract(
    name: StarknetContractName,
    address: string,
    providerOrAccount?: RpcProvider | AccountInterface,
    contractType?: ContractType,
  ): Contract {
    return getStarknetContract(
      name,
      address,
      providerOrAccount ?? this.provider,
      contractType,
    );
  }

  protected get accountAddress(): string {
    throw new Error('StarknetProvider has no signer account');
  }

  protected get feeTokenAddress(): string {
    return getFeeTokenAddress({
      chainName: this.metadata.name,
      nativeDenom: this.metadata.nativeToken?.denom,
    });
  }

  getFeeTokenAddress(): string {
    return this.feeTokenAddress;
  }

  protected parseString(value: unknown): string {
    if (typeof value === 'string') return value;

    if (typeof value === 'number' || typeof value === 'bigint') {
      try {
        return shortString.decodeShortString(
          ensure0x(BigInt(value).toString(16)),
        );
      } catch {
        return value.toString();
      }
    }

    if (value && typeof value === 'object') {
      if ('value' in value) return this.parseString(value.value);

      const toStringFn = Reflect.get(value, 'toString');
      if (
        typeof toStringFn === 'function' &&
        toStringFn !== Object.prototype.toString
      ) {
        const parsed = Reflect.apply(toStringFn, value, []);
        if (typeof parsed === 'string' && parsed !== '[object Object]') {
          return parsed;
        }
      }
    }

    return '';
  }

  protected async populateInvokeCall(
    contract: Contract,
    method: string,
    args: RawArgsArray = [],
  ): Promise<{
    contractAddress: string;
    entrypoint: string;
    calldata: RawArgsArray;
  }> {
    const tx = await populateInvokeTx(contract, method, args);
    assert(tx.kind === 'invoke', 'Expected invoke Starknet transaction');

    return {
      contractAddress: normalizeStarknetAddressSafe(tx.contractAddress),
      entrypoint: tx.entrypoint,
      calldata: tx.calldata,
    };
  }

  protected unwrapBalance(value: unknown): unknown {
    if (value && typeof value === 'object' && 'balance' in value) {
      return value.balance;
    }
    return value;
  }

  protected async determineTokenType(
    tokenAddress: string,
  ): Promise<AltVM.TokenType> {
    const address = normalizeStarknetAddressSafe(tokenAddress);
    const classHash = await this.provider.getClassHashAt(address);
    const tokenType = getTokenTypeByClassHash().get(
      BigInt(classHash).toString(),
    );
    if (tokenType) return tokenType;

    try {
      const collateral = this.withContract(
        StarknetContractName.HYP_ERC20_COLLATERAL,
        address,
        this.provider,
        ContractType.TOKEN,
      );
      await callContract(collateral, 'get_wrapped_token');
      return AltVM.TokenType.collateral;
    } catch (error) {
      if (!isProbeMiss(error)) throw error;
    }

    try {
      const native = this.withContract(
        StarknetContractName.HYP_NATIVE,
        address,
        this.provider,
        ContractType.TOKEN,
      );
      await callContract(native, 'native_token');
      return AltVM.TokenType.native;
    } catch (error) {
      if (!isProbeMiss(error)) throw error;
    }

    return AltVM.TokenType.synthetic;
  }

  /**
   * Reads ERC20 metadata by fetching the contract's own ABI from chain,
   * so starknet.js parses responses correctly regardless of whether
   * the contract uses felt252 (Cairo 0) or ByteArray (Cairo 1).
   */
  protected async getTokenMetadata(tokenAddress: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  }> {
    const nativeToken = this.metadata.nativeToken;
    if (
      nativeToken?.denom &&
      normalizeStarknetAddressSafe(tokenAddress) ===
        normalizeStarknetAddressSafe(nativeToken.denom)
    ) {
      return {
        name: nativeToken.name,
        symbol: nativeToken.symbol,
        decimals: nativeToken.decimals ?? 18,
      };
    }

    const address = normalizeStarknetAddressSafe(tokenAddress);
    const token = await getOnChainStarknetContract(this.provider, address);

    const [name, symbol, decimals] = await Promise.all([
      callContract(token, 'name'),
      callContract(token, 'symbol'),
      callContract(token, 'decimals'),
    ]);

    return {
      name: this.parseString(name),
      symbol: this.parseString(symbol),
      decimals: toNumber(decimals),
    };
  }

  protected parseHookVariant(variant: string): AltVM.HookType {
    const upper = variant.toUpperCase();
    if (upper.includes('MERKLE_TREE')) return AltVM.HookType.MERKLE_TREE;
    if (upper.includes('PROTOCOL_FEE')) return AltVM.HookType.PROTOCOL_FEE;
    if (upper.includes('INTERCHAIN_GAS_PAYMASTER')) {
      return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
    }
    return AltVM.HookType.CUSTOM;
  }

  protected parseIsmVariant(variant: string): AltVM.IsmType {
    const upper = variant.toUpperCase();
    if (
      upper.includes('TEST') ||
      upper.includes('NOOP') ||
      upper.includes('NULL') ||
      upper.includes('UNUSED')
    ) {
      return AltVM.IsmType.TEST_ISM;
    }
    if (upper.includes('MERKLE_ROOT_MULTISIG')) {
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    }
    if (upper.includes('MESSAGE_ID_MULTISIG')) {
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    }
    if (upper.includes('ROUTING')) {
      return AltVM.IsmType.ROUTING;
    }
    return AltVM.IsmType.CUSTOM;
  }

  // ### QUERY BASE ###

  async isHealthy(): Promise<boolean> {
    try {
      await this.provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    const tokenAddress = req.denom
      ? normalizeStarknetAddressSafe(req.denom)
      : this.feeTokenAddress;
    const token = this.withContract(
      StarknetContractName.ETHER,
      tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );

    let balance: unknown;
    try {
      balance = await callContract(token, 'balanceOf', [
        normalizeStarknetAddressSafe(req.address),
      ]);
    } catch (error) {
      if (!isProbeMiss(error)) throw error;
      balance = await callContract(token, 'balance_of', [
        normalizeStarknetAddressSafe(req.address),
      ]);
    }

    return toBigInt(this.unwrapBalance(balance));
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    const tokenAddress = req.denom
      ? normalizeStarknetAddressSafe(req.denom)
      : this.feeTokenAddress;
    const token = this.withContract(
      StarknetContractName.ETHER,
      tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );
    return toBigInt(await callContract(token, 'total_supply'));
  }

  async estimateTransactionFee(
    _req: AltVM.ReqEstimateTransactionFee<StarknetAnnotatedTx>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    throw new Error(
      'Starknet transaction fee estimation is unsupported without an account-backed signer',
    );
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    return isMessageDelivered(this.provider, req.mailboxAddress, req.messageId);
  }

  // ### QUERY WARP ###

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const tokenAddress = normalizeStarknetAddressSafe(req.tokenAddress);
    const token = this.withContract(
      StarknetContractName.HYP_ERC20,
      tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );

    const tokenType = await this.determineTokenType(tokenAddress);

    const [owner, mailboxAddress, ismAddress, hookAddress] = await Promise.all([
      callContract(token, 'owner'),
      callContract(token, 'mailbox'),
      callContract(token, 'interchain_security_module'),
      callContract(token, 'get_hook'),
    ]);

    let denom = tokenAddress;
    let name = '';
    let symbol = '';
    let decimals = this.metadata.nativeToken?.decimals ?? 18;

    try {
      const metadata = await this.getTokenMetadata(tokenAddress);
      name = metadata.name;
      symbol = metadata.symbol;
      decimals = metadata.decimals;
    } catch (error) {
      if (!isProbeMiss(error)) throw error;
    }

    if (tokenType === AltVM.TokenType.collateral) {
      const collateral = this.withContract(
        StarknetContractName.HYP_ERC20_COLLATERAL,
        tokenAddress,
        this.provider,
        ContractType.TOKEN,
      );
      const wrapped = await callContract(collateral, 'get_wrapped_token');
      denom = normalizeStarknetAddressSafe(wrapped);

      try {
        const wrappedMeta = await this.getTokenMetadata(denom);
        name = wrappedMeta.name;
        symbol = wrappedMeta.symbol;
        decimals = wrappedMeta.decimals;
      } catch (error) {
        if (!isProbeMiss(error)) throw error;
      }
    } else if (tokenType === AltVM.TokenType.native) {
      const native = this.withContract(
        StarknetContractName.HYP_NATIVE,
        tokenAddress,
        this.provider,
        ContractType.TOKEN,
      );

      try {
        const nativeTokenAddress = await callContract(native, 'native_token');
        denom = normalizeStarknetAddressSafe(nativeTokenAddress);
      } catch (error) {
        if (!isProbeMiss(error)) throw error;
        denom = this.metadata.nativeToken?.denom ?? this.feeTokenAddress;
      }

      name = this.metadata.nativeToken?.name ?? name;
      symbol = this.metadata.nativeToken?.symbol ?? symbol;
      decimals = this.metadata.nativeToken?.decimals ?? decimals;
    }

    return {
      address: tokenAddress,
      owner: normalizeStarknetAddressSafe(owner),
      tokenType,
      mailboxAddress: normalizeStarknetAddressSafe(mailboxAddress),
      ismAddress: normalizeStarknetAddressSafe(ismAddress),
      hookAddress: normalizeStarknetAddressSafe(hookAddress),
      denom,
      name,
      symbol,
      decimals,
    };
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const token = this.withContract(
      StarknetContractName.HYP_ERC20,
      req.tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );

    const domains = await callContract(token, 'domains');
    assert(Array.isArray(domains), 'Expected Starknet token domains array');

    const remoteRouters = await Promise.all(
      domains.map(async (domainId) => {
        const domain = toNumber(domainId);
        const [routerAddress, gas] = await Promise.all([
          callContract(token, 'routers', [domainId]),
          callContract(token, 'destination_gas', [domainId]).catch(() => 0),
        ]);

        return {
          receiverDomainId: domain,
          receiverAddress: normalizeRoutersAddress(routerAddress),
          gas: toBigInt(gas).toString(),
        };
      }),
    );

    return {
      address: normalizeStarknetAddressSafe(req.tokenAddress),
      remoteRouters,
    };
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const tokenInfo = await this.getToken({ tokenAddress: req.tokenAddress });
    const token = this.withContract(
      StarknetContractName.HYP_ERC20,
      req.tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );

    if (tokenInfo.tokenType === AltVM.TokenType.synthetic) {
      return toBigInt(await callContract(token, 'total_supply'));
    }

    return this.getBalance({
      address: req.tokenAddress,
      denom: tokenInfo.denom,
    });
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const token = this.withContract(
      StarknetContractName.HYP_ERC20,
      req.tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );

    const quote = await callContract(token, 'quote_gas_payment', [
      req.destinationDomainId,
    ]);
    return {
      denom: this.feeTokenAddress,
      amount: toBigInt(quote),
    };
  }

  // ### TRANSFER TXS ###

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<StarknetAnnotatedTx> {
    const denom = req.denom
      ? normalizeStarknetAddressSafe(req.denom)
      : this.feeTokenAddress;
    const token = this.withContract(
      StarknetContractName.ETHER,
      denom,
      this.provider,
      ContractType.TOKEN,
    );
    return populateInvokeTx(token, 'transfer', [
      normalizeStarknetAddressSafe(req.recipient),
      req.amount,
    ]);
  }

  async getRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<StarknetAnnotatedTx> {
    return this.buildRemoteTransferTransaction(req);
  }

  protected async buildRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
    tokenInfo?: AltVM.ResGetToken,
  ): Promise<StarknetAnnotatedTx> {
    if (req.customHookAddress || req.customHookMetadata) {
      throw new Error(
        'Custom hook metadata/addresses are unsupported for Starknet transfer_remote in provider-sdk',
      );
    }

    const tokenType =
      tokenInfo?.tokenType ?? (await this.determineTokenType(req.tokenAddress));
    const token = this.withContract(
      StarknetContractName.HYP_ERC20,
      req.tokenAddress,
      this.provider,
      ContractType.TOKEN,
    );
    const noneOption = new CairoOption(CairoOptionVariant.None);
    let value: bigint;
    if (tokenType === AltVM.TokenType.native) {
      value = toBigInt(req.amount) + toBigInt(req.maxFee.amount);
    } else if (tokenType === AltVM.TokenType.collateral) {
      value = toBigInt(req.maxFee.amount);
    } else {
      value = toBigInt(req.maxFee.amount);
    }

    return populateInvokeTx(token, 'transfer_remote', [
      req.destinationDomainId,
      addressToBytes32(req.recipient),
      req.amount,
      value,
      noneOption,
      noneOption,
    ]);
  }
}
