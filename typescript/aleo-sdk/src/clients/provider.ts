import { U128 } from '@provablehq/sdk/mainnet.js';
import { BigNumber } from 'bignumber.js';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  ALEO_NATIVE_DENOM,
  ALEO_NULL_ADDRESS,
  U128ToString,
  arrayToPlaintext,
  bytes32ToU128String,
  fillArray,
  formatAddress,
  fromAleoAddress,
  generateSuffix,
  getAddressFromProgramId,
  getBalanceKey,
  getProgramIdFromSuffix,
  getProgramSuffix,
  toAleoAddress,
} from '../utils/helper.js';
import { AleoTokenType, type AleoTransaction } from '../utils/types.js';
import { getRemoteRouters } from '../warp/warp-query.js';

import { AleoBase } from './base.js';

interface TransactionFeeCache {
  [key: string]: {
    fee: bigint;
  };
}

export class AleoProvider extends AleoBase implements AltVM.IProvider {
  private transactionFeeCache: TransactionFeeCache = {};

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
    return generateSuffix(n);
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
    let aleoAddress = req.address;

    if (aleoAddress.includes('/')) {
      aleoAddress = req.address.split('/')[1];
    }

    if (req.denom && req.denom !== 'credits' && req.denom !== '0field') {
      const result = await this.queryMappingValue(
        'token_registry.aleo',
        'authorized_balances',
        getBalanceKey(aleoAddress, req.denom),
      );

      if (!result) {
        return 0n;
      }

      return result['balance'];
    }

    const balance = await this.aleoClient.getPublicBalance(aleoAddress);
    return BigInt(balance);
  }

  async getTotalSupply(
    req: AltVM.ReqGetTotalSupply & { programId?: string },
  ): Promise<bigint> {
    if (!req.denom) {
      return 0n;
    }

    let result = null;

    // The USAD deployment is a special case
    // It doesn't use the token_registry to mint tokens, but instead has a custom program on Aleo
    // Query the USAD token program to get the total supply for USAD instead of the token_registry
    if (req.programId && req.programId === 'hyp_warp_token_usad.aleo') {
      result = await this.queryMappingValue(
        'usad_stablecoin.aleo',
        'token_info',
        'true',
      );
    } else {
      result = await this.queryMappingValue(
        'token_registry.aleo',
        'registered_tokens',
        req.denom,
      );
    }

    if (!result) {
      return 0n;
    }

    return result['supply'];
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<AleoTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const cacheKey = `${req.transaction.programName}:${req.transaction.functionName}`;

    const cached = this.transactionFeeCache[cacheKey];
    if (cached) {
      return {
        fee: cached.fee,
        gasUnits: 0n,
        gasPrice: 0,
      };
    }

    const programManager = this.getProgramManager();
    const fee = await programManager.estimateExecutionFee({
      programName: req.transaction.programName,
      functionName: req.transaction.functionName,
    });

    this.transactionFeeCache[cacheKey] = {
      fee,
    };

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
      this.prefix,
      `hook_manager`,
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
        : `${getProgramIdFromSuffix(this.prefix, 'hook_manager', getProgramSuffix(mailboxProgramId))}/${tokenMetadata.hook}`;
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
    const remoteRouters = await getRemoteRouters(
      this.aleoClient,
      req.tokenAddress,
    );

    return {
      address: req.tokenAddress,
      remoteRouters: Object.entries(remoteRouters).map(([domainId, data]) => ({
        gas: data.gas,
        receiverAddress: data.address,
        receiverDomainId: parseInt(domainId),
      })),
    };
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const { programId } = fromAleoAddress(req.tokenAddress);

    const metadata = await this.queryMappingValue(
      programId,
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
          programId,
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
    const { mailboxAddress, tokenType } = await this.getToken({
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

    const amount = `${req.amount}${tokenType === AltVM.TokenType.native ? 'u64' : 'u128'}`;

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
          amount,
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
        amount,
        arrayToPlaintext(creditAllowance),
      ],
    };
  }
}
