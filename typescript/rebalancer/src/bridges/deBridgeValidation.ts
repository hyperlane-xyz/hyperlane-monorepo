import { createHash } from 'node:crypto';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import { utils } from 'ethers';

import { addressToBytesTron, assert } from '@hyperlane-xyz/utils';

import type { BridgeQuote } from '../interfaces/IExternalBridge.js';
import {
  DLN_FORWARDER,
  validateDeBridgeForwarder,
} from './deBridgeForwarderValidation.js';
import {
  DEBRIDGE_SOLANA_CHAIN_ID,
  DEBRIDGE_TRON_CHAIN_ID,
  hyperlaneChainIdToDebridge,
} from './deBridgeUtils.js';

// https://docs.debridge.com/dln-details/overview/deployed-contracts
export const DLN_EVM_SOURCE = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66';
export const DLN_TRON_SOURCE = utils.getAddress(
  utils.hexlify(addressToBytesTron('TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5')),
);
export const DLN_SOLANA_SOURCE = new PublicKey(
  'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4',
);

// dln-contracts@d54e94f2b5102bff89a4df506404bb77f3edc148, IDlnSource / DlnOrderLib.OrderCreation.
const ORDER_CREATION =
  '(address giveTokenAddress,uint256 giveAmount,bytes takeTokenAddress,uint256 takeAmount,uint256 takeChainId,bytes receiverDst,address givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes externalCall,bytes allowedCancelBeneficiarySrc)';
export const DLN_SOURCE_INTERFACE = new utils.Interface([
  `function createOrder(${ORDER_CREATION} order,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope) payable`,
  `function createSaltedOrder(${ORDER_CREATION} order,uint64 salt,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope,bytes metadata) payable`,
]);

export function deBridgeAddressBytes(address: string, chainId: number): string {
  const chain = hyperlaneChainIdToDebridge(chainId);
  if (chain === DEBRIDGE_SOLANA_CHAIN_ID)
    return utils.hexlify(new PublicKey(address).toBytes());
  if (chain === DEBRIDGE_TRON_CHAIN_ID && address.startsWith('T'))
    return utils.hexlify(addressToBytesTron(address));
  return utils.getAddress(address).toLowerCase();
}

/** Direct orders and explicitly decoded source-swap wrappers are supported. */
export function validateDeBridgeEvmTransaction(
  quote: BridgeQuote,
  to: string,
  data: string,
): void {
  const { fromChain, toChain, fromToken, toToken, fromAddress, toAddress } =
    quote.requestParams;
  const chain = hyperlaneChainIdToDebridge(fromChain);
  const source =
    chain === DEBRIDGE_TRON_CHAIN_ID ? DLN_TRON_SOURCE : DLN_EVM_SOURCE;
  assert(
    [1, 56, 42161, DEBRIDGE_TRON_CHAIN_ID].includes(chain),
    'Unsupported DLN source chain',
  );
  const wrapped = to.toLowerCase() === DLN_FORWARDER.toLowerCase();
  assert(
    wrapped || to.toLowerCase() === source.toLowerCase(),
    'deBridge transaction target is not the documented DLN source',
  );
  const input = wrapped
    ? validateDeBridgeForwarder(quote, data, source)
    : { data, token: fromToken, amount: quote.fromAmount };
  const decoded = DLN_SOURCE_INTERFACE.parseTransaction({ data: input.data });
  assert(
    DLN_SOURCE_INTERFACE.encodeFunctionData(
      decoded.functionFragment,
      decoded.args,
    ).toLowerCase() === input.data.toLowerCase(),
    'deBridge order calldata is not canonical',
  );
  const order = decoded.args.order;
  assert(toAddress, 'deBridge destination recipient is required');
  const sender = deBridgeAddressBytes(fromAddress, fromChain);
  const recipient = deBridgeAddressBytes(toAddress, toChain);
  assert(
    order.giveTokenAddress.toLowerCase() ===
      deBridgeAddressBytes(input.token, fromChain).toLowerCase(),
    'deBridge order source token mismatch',
  );
  assert(
    BigInt(order.giveAmount.toString()) === input.amount,
    'deBridge order source amount mismatch',
  );
  assert(
    order.takeTokenAddress.toLowerCase() ===
      deBridgeAddressBytes(toToken, toChain).toLowerCase(),
    'deBridge order destination token mismatch',
  );
  assert(
    BigInt(order.takeChainId.toString()) ===
      BigInt(hyperlaneChainIdToDebridge(toChain)),
    'deBridge order destination chain mismatch',
  );
  assert(
    BigInt(order.takeAmount.toString()) >= quote.toAmountMin,
    'deBridge order output below accepted minimum',
  );
  assert(
    order.receiverDst.toLowerCase() === recipient.toLowerCase(),
    'deBridge order recipient mismatch',
  );
  assert(
    order.givePatchAuthoritySrc.toLowerCase() === sender.toLowerCase(),
    'deBridge order source authority mismatch',
  );
  assert(
    order.orderAuthorityAddressDst.toLowerCase() === recipient.toLowerCase(),
    'deBridge order destination authority mismatch',
  );
  assert(
    order.allowedCancelBeneficiarySrc === '0x' ||
      order.allowedCancelBeneficiarySrc.toLowerCase() === sender.toLowerCase(),
    'deBridge order refund beneficiary mismatch',
  );
  assert(
    order.allowedTakerDst === '0x' && order.externalCall === '0x',
    'deBridge restricted takers and external calls are unsupported',
  );
  assert(
    decoded.args.affiliateFee === '0x' && decoded.args.permitEnvelope === '0x',
    'deBridge affiliate fees and permit envelopes are unsupported',
  );
}

// Borsh layouts: abis-and-idls@1a4c5fa1b59613e824c72dfc473ba7b3d6f5042c/idls/src.ts.
// Read only the two create-order shapes; reject trailing data and unsupported optional calls.
class OrderReader {
  private offset = 8;
  constructor(private readonly data: Buffer) {}
  bytes(length: number): Buffer {
    assert(
      length >= 0 && this.offset + length <= this.data.length,
      'Truncated DLN Solana order',
    );
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  vector(): Buffer {
    return this.bytes(this.bytes(4).readUInt32LE());
  }
  option(read: () => Buffer): Buffer | undefined {
    const flag = this.bytes(1)[0];
    assert(flag === 0 || flag === 1, 'Invalid DLN Solana option');
    return flag === 1 ? read() : undefined;
  }
  done(): void {
    assert(
      this.offset === this.data.length,
      'Unexpected DLN Solana order data',
    );
  }
}

const createOrderDiscriminator = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const CREATE_ORDER = createOrderDiscriminator('create_order');
const CREATE_ORDER_WITH_NONCE = createOrderDiscriminator(
  'create_order_with_nonce',
);

export function validateDeBridgeSolanaInstructions(
  quote: BridgeQuote,
  signer: PublicKey,
  instructions: TransactionInstruction[],
): void {
  const mint = new PublicKey(quote.requestParams.fromToken);
  const senderToken = getAssociatedTokenAddressSync(mint, signer);
  let orders = 0;
  let units = 1_400_000n;
  let microLamports = 0n;
  const budgetKinds = new Set<number>();
  for (const ix of instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const kind = ix.data[0];
      assert(
        ix.keys.length === 0 && !budgetKinds.has(kind),
        'Invalid DLN compute budget instruction',
      );
      budgetKinds.add(kind);
      if (kind === 2 && ix.data.length === 5)
        units = BigInt(ix.data.readUInt32LE(1));
      else if (kind === 3 && ix.data.length === 9)
        microLamports = ix.data.readBigUInt64LE(1);
      else throw new Error('Unsupported DLN compute budget instruction');
      continue;
    }
    assert(
      ix.programId.equals(DLN_SOLANA_SOURCE),
      'deBridge Solana transaction invokes an unsupported program',
    );
    assert(
      ++orders === 1,
      'deBridge Solana transaction must create exactly one order',
    );
    const withNonce = ix.data.subarray(0, 8).equals(CREATE_ORDER_WITH_NONCE);
    assert(
      withNonce || ix.data.subarray(0, 8).equals(CREATE_ORDER),
      'Unsupported DLN Solana instruction',
    );
    assert(ix.keys.length === 12, 'Unexpected DLN Solana order accounts');
    assert(
      ix.keys[0].pubkey.equals(signer) && ix.keys[0].isSigner,
      'DLN Solana maker mismatch',
    );
    assert(
      ix.keys[2].pubkey.equals(mint) && ix.keys[5].pubkey.equals(senderToken),
      'DLN Solana source token account mismatch',
    );
    assert(
      ix.keys[9].pubkey.equals(SystemProgram.programId) &&
        ix.keys[10].pubkey.equals(TOKEN_PROGRAM_ID) &&
        ix.keys[11].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
      'DLN Solana support program mismatch',
    );
    for (const [index, account] of ix.keys.entries()) {
      assert(index === 0 || !account.isSigner, 'DLN Solana extra signer');
      assert(
        [0, 3, 5, 6, 7, 8].includes(index) || !account.isWritable,
        'DLN Solana unexpected writable account',
      );
    }
    const reader = new OrderReader(ix.data);
    assert(
      reader.bytes(8).readBigUInt64LE() === quote.fromAmount,
      'DLN Solana source amount mismatch',
    );
    const uint256 = () => BigInt(utils.hexlify(reader.bytes(32)));
    assert(
      uint256() ===
        BigInt(hyperlaneChainIdToDebridge(quote.requestParams.toChain)),
      'DLN Solana destination chain mismatch',
    );
    assert(
      utils.hexlify(reader.vector()) ===
        deBridgeAddressBytes(
          quote.requestParams.toToken,
          quote.requestParams.toChain,
        ).toLowerCase(),
      'DLN Solana destination token mismatch',
    );
    assert(
      uint256() >= quote.toAmountMin,
      'DLN Solana output below accepted minimum',
    );
    assert(
      quote.requestParams.toAddress,
      'DLN Solana destination recipient is required',
    );
    const recipient = deBridgeAddressBytes(
      quote.requestParams.toAddress,
      quote.requestParams.toChain,
    ).toLowerCase();
    assert(
      utils.hexlify(reader.vector()) === recipient,
      'DLN Solana recipient mismatch',
    );
    assert(
      reader.option(() => reader.vector()) === undefined,
      'DLN Solana external calls are unsupported',
    );
    assert(
      new PublicKey(reader.bytes(32)).equals(signer),
      'DLN Solana source authority mismatch',
    );
    const refund = reader.option(() => reader.bytes(32));
    assert(
      !refund || new PublicKey(refund).equals(signer),
      'DLN Solana refund beneficiary mismatch',
    );
    assert(
      utils.hexlify(reader.vector()) === recipient,
      'DLN Solana destination authority mismatch',
    );
    assert(
      reader.option(() => reader.vector()) === undefined,
      'DLN Solana restricted takers are unsupported',
    );
    assert(
      reader.option(() => reader.bytes(40)) === undefined,
      'DLN Solana affiliate fees are unsupported',
    );
    reader.option(() => reader.bytes(4)); // Referral code does not change asset effects.
    if (withNonce) {
      reader.bytes(8);
      reader.vector();
    }
    reader.done();
  }
  assert(
    orders === 1,
    'deBridge Solana transaction must create exactly one order',
  );
  assert(
    units > 0n &&
      units <= 1_400_000n &&
      units * microLamports <= 10_000_000n * 1_000_000n,
    'DLN Solana priority fee exceeds 0.01 SOL',
  );
}
