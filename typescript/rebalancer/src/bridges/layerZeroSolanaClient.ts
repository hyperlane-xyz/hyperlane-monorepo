import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { oft } from '@layerzerolabs/oft-v2-solana-sdk';
import {
  createSignerFromKeypair,
  signerIdentity,
  transactionBuilder,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  fromWeb3JsKeypair,
  fromWeb3JsPublicKey,
} from '@metaplex-foundation/umi-web3js-adapters';
import bs58 from 'bs58';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import type {
  LayerZeroSolanaBridgeRoute,
  MessagingFee,
} from './layerZeroUtils.js';

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

// The USDT0 OFT program uses a custom OFTStore layout where tokenEscrow
// is at byte offset 40 (after 8-byte discriminator + 32-byte tokenMint).
// The standard SDK deserializer fails because the layout differs from the
// canonical OFT program, so we read the escrow pubkey from raw account data.
const OFT_STORE_TOKEN_ESCROW_OFFSET = 40;

async function resolveAccounts(
  rpcUrl: string,
  payerAddress: string,
  store: string,
  tokenMint: string,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const umi = createUmi(connection);
  const payer = new PublicKey(payerAddress);
  const tokenMintKey = new PublicKey(tokenMint);

  const storeAccountInfo = await connection.getAccountInfo(
    new PublicKey(store),
  );
  assert(storeAccountInfo, `OFT Store account not found: ${store}`);
  const escrowBytes = storeAccountInfo.data.subarray(
    OFT_STORE_TOKEN_ESCROW_OFFSET,
    OFT_STORE_TOKEN_ESCROW_OFFSET + 32,
  );
  const tokenEscrow = fromWeb3JsPublicKey(new PublicKey(escrowBytes));

  return {
    connection,
    umi,
    payer,
    payerUmi: fromWeb3JsPublicKey(payer),
    tokenMint: tokenMintKey,
    tokenMintUmi: fromWeb3JsPublicKey(tokenMintKey),
    tokenEscrow,
  };
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
  const { umi, payerUmi, tokenMintUmi, tokenEscrow } = await resolveAccounts(
    rpcUrl,
    fromAddress,
    store,
    tokenMint,
  );
  const oftProgram = fromWeb3JsPublicKey(new PublicKey(programId));
  const options = hexToBytes(extraOptionsHex);
  const composeMsg = hexToBytes(composeMsgHex);

  const oftQuote = await oft.quoteOft(
    umi.rpc,
    {
      payer: payerUmi,
      tokenMint: tokenMintUmi,
      tokenEscrow,
    },
    {
      dstEid,
      to: bytes32HexToBytes(toBytes32),
      amountLd,
      minAmountLd,
      options,
      composeMsg,
    },
    oftProgram,
  );

  const amountReceivedLd = oftQuote.oftReceipt.amountReceivedLd;
  const feeCosts = oftQuote.oftFeeDetails.reduce(
    (sum, fee) => sum + fee.feeAmountLd,
    0n,
  );

  const messagingFee = await oft.quote(
    umi.rpc,
    {
      payer: payerUmi,
      tokenMint: tokenMintUmi,
      tokenEscrow,
    },
    {
      dstEid,
      to: bytes32HexToBytes(toBytes32),
      amountLd,
      minAmountLd: amountReceivedLd,
      options,
      composeMsg,
    },
    { oft: oftProgram },
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
  const web3Keypair = Keypair.fromSecretKey(secretKey);
  const { connection, umi, tokenMint, tokenMintUmi, tokenEscrow } =
    await resolveAccounts(
      rpcUrl,
      web3Keypair.publicKey.toBase58(),
      route.store,
      route.tokenMint,
    );
  const signer = createSignerFromKeypair(umi, fromWeb3JsKeypair(web3Keypair));
  umi.use(signerIdentity(signer));

  const tokenSource = getAssociatedTokenAddressSync(
    tokenMint,
    web3Keypair.publicKey,
  );
  const tokenSourceAccount = await connection.getAccountInfo(tokenSource);
  assert(
    tokenSourceAccount,
    `Missing Solana source ATA ${tokenSource.toBase58()} for mint ${route.tokenMint}`,
  );

  const wrappedInstruction = await oft.send(
    umi.rpc,
    {
      payer: signer,
      tokenMint: tokenMintUmi,
      tokenEscrow,
      tokenSource: fromWeb3JsPublicKey(tokenSource),
    },
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
    {
      oft: fromWeb3JsPublicKey(new PublicKey(route.programId)),
    },
  );

  const result = await transactionBuilder()
    .add(wrappedInstruction)
    .sendAndConfirm(umi);
  return bs58.encode(result.signature);
}

export const solanaLayerZeroClient = {
  quoteSolanaTransfer,
  executeSolanaTransfer,
};
