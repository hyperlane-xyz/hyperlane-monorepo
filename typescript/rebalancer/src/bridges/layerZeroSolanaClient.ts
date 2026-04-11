import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import type {
  LayerZeroSolanaBridgeRoute,
  MessagingFee,
} from './layerZeroUtils.js';
import {
  quoteUsdt0Oft,
  quoteUsdt0Send,
  resolveUsdt0MeshAccounts,
  sendUsdt0Transfer,
} from './layerZeroSolanaMesh.js';

type SolanaQuoteRequest = {
  rpcUrl: string;
  fromAddress: string;
  programId: string;
  store: string;
  tokenMint: string;
  dstEid: number;
  toBytes32: string;
  amountLd: bigint;
  minAmountLd: bigint;
  extraOptionsHex?: string;
  composeMsgHex?: string;
};

type SolanaQuoteResult = {
  amountReceivedLd: bigint;
  feeCosts: bigint;
  messagingFee: MessagingFee;
};

function hexToBytes(hex: string | undefined): Uint8Array | undefined {
  const normalized = ensure0x(hex ?? '0x');
  if (normalized === '0x') return undefined;
  return Uint8Array.from(Buffer.from(normalized.slice(2), 'hex'));
}

function bytes32HexToBytes(bytes32Hex: string): Uint8Array {
  const normalized = ensure0x(bytes32Hex);
  return Uint8Array.from(Buffer.from(normalized.slice(2), 'hex'));
}

async function resolveAccounts(
  rpcUrl: string,
  request: {
    payerAddress: string;
    programId: string;
    store: string;
    tokenMint: string;
    dstEid: number;
  },
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const umi = createUmi(connection);
  const payer = new PublicKey(request.payerAddress);
  const meshAccounts = await resolveUsdt0MeshAccounts(connection, {
    programId: request.programId,
    store: request.store,
    tokenMint: request.tokenMint,
    dstEid: request.dstEid,
  });

  return { connection, umi, payer, meshAccounts };
}

export async function quoteSolanaTransfer(
  request: SolanaQuoteRequest,
): Promise<SolanaQuoteResult> {
  const {
    rpcUrl,
    fromAddress,
    programId,
    store,
    tokenMint,
    dstEid,
    toBytes32,
    amountLd,
    minAmountLd,
    extraOptionsHex,
    composeMsgHex,
  } = request;
  const { connection, umi, payer, meshAccounts } = await resolveAccounts(
    rpcUrl,
    {
      payerAddress: fromAddress,
      programId,
      store,
      tokenMint,
      dstEid,
    },
  );

  const quoteParams = {
    dstEid,
    to: bytes32HexToBytes(toBytes32),
    amountLd,
    minAmountLd,
    options: hexToBytes(extraOptionsHex),
    composeMsg: hexToBytes(composeMsgHex),
    payInLzToken: false,
  };
  const oftQuote = await quoteUsdt0Oft(
    connection,
    meshAccounts,
    payer,
    quoteParams,
  );

  const amountReceivedLd = oftQuote.oftReceipt.amountReceivedLd;
  const feeCosts = oftQuote.oftFeeDetails.reduce(
    (sum, fee) => sum + fee.feeAmountLd,
    0n,
  );

  const messagingFee = await quoteUsdt0Send(
    connection,
    umi.rpc,
    meshAccounts,
    payer,
    {
      ...quoteParams,
      minAmountLd: amountReceivedLd,
    },
  );

  return {
    amountReceivedLd,
    feeCosts,
    messagingFee: {
      nativeFee: messagingFee.nativeFee,
      lzTokenFee: messagingFee.lzTokenFee,
    },
  };
}

export async function executeSolanaTransfer(
  route: LayerZeroSolanaBridgeRoute,
  privateKey: string,
  rpcUrl: string,
): Promise<string> {
  const secretKey = parseSolanaPrivateKey(privateKey);
  const signer = Keypair.fromSecretKey(secretKey);
  const { connection, umi, meshAccounts } = await resolveAccounts(rpcUrl, {
    payerAddress: signer.publicKey.toBase58(),
    programId: route.programId,
    store: route.store,
    tokenMint: route.tokenMint,
    dstEid: route.destinationEid,
  });

  const tokenSource = getAssociatedTokenAddressSync(
    meshAccounts.tokenMint,
    signer.publicKey,
  );
  const tokenSourceAccount = await connection.getAccountInfo(
    tokenSource,
    'confirmed',
  );
  assert(
    tokenSourceAccount,
    `Missing Solana source ATA ${tokenSource.toBase58()} for mint ${route.tokenMint}`,
  );

  return sendUsdt0Transfer(
    connection,
    umi.rpc,
    meshAccounts,
    signer,
    tokenSource,
    {
      dstEid: route.destinationEid,
      to: bytes32HexToBytes(route.toBytes32),
      amountLd: route.amountLd,
      minAmountLd: route.minAmountLd,
      options: hexToBytes(route.extraOptionsHex),
      composeMsg: hexToBytes(route.composeMsgHex),
      nativeFee: route.nativeFeeLamports,
      lzTokenFee: route.lzTokenFee,
    },
    tokenSourceAccount.owner,
  );
}

export const solanaLayerZeroClient = {
  quoteSolanaTransfer,
  executeSolanaTransfer,
};
