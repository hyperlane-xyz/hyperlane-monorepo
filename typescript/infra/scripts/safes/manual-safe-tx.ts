// Signs or executes a Safe transaction directly over RPC, for chains with no
// Safe Transaction Service (e.g. viction) where the normal propose/sign flow
// via app.safe.global or SafeMultiSend isn't available. Uses only public
// registry chain metadata and a user-supplied private key — no deployer-key
// or GCP access required.
//
// Input is a "<chain>.raw.json" file as produced by update-signers.ts's
// tx-service-unavailable fallback: { chain, chainId, safeAddress, transactions }.
//
// Usage:
//   Each owner signs independently and shares their signature:
//     tsx manual-safe-tx.ts sign --file viction.raw.json --key $HYP_KEY --out alice.sig.json
//
//   Once >= threshold signature files are collected, anyone executes:
//     tsx manual-safe-tx.ts execute --file viction.raw.json --key $HYP_KEY \
//       --signatures alice.sig.json --signatures bob.sig.json ...

import { EthSafeSignature } from '@safe-global/protocol-kit';
import { BigNumber } from 'ethers';
import yargs from 'yargs';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider, getSafe } from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import {
  createSafeTransaction,
  createSafeTransactionData,
} from '../../src/utils/safe.js';
import { writeAndFormatJsonAtPath } from '../../src/utils/utils.js';

interface RawTxFile {
  chain: string;
  safeAddress: string;
  transactions: Array<{ to: string; value: string; data: string }>;
}

interface StoredSignature {
  signer: string;
  data: string;
}

async function buildMultiProvider(): Promise<MultiProvider> {
  const registry = getRegistry({
    registryUris: [DEFAULT_GITHUB_REGISTRY],
    enableProxy: true,
  });
  const chainMetadata = await registry.getMetadata();
  return new MultiProvider(chainMetadata);
}

async function loadSafeTransaction(
  multiProvider: MultiProvider,
  txFile: RawTxFile,
  signer: string,
  nonce: number | undefined,
) {
  const safeSdk = await getSafe(
    txFile.chain,
    multiProvider,
    txFile.safeAddress,
    signer,
    { allowUnresolvedSafeVersion: true },
  );
  const metaTxs = txFile.transactions.map((tx) =>
    createSafeTransactionData({
      to: tx.to,
      data: tx.data,
      value: BigNumber.from(tx.value),
    }),
  );
  const safeTransaction = await createSafeTransaction(
    safeSdk,
    metaTxs,
    undefined,
    nonce,
  );
  return { safeSdk, safeTransaction };
}

async function sign(argv: {
  file: string;
  key: string;
  nonce?: number;
  out?: string;
}) {
  const txFile = readJson<RawTxFile>(argv.file);
  const multiProvider = await buildMultiProvider();
  const { safeSdk, safeTransaction } = await loadSafeTransaction(
    multiProvider,
    txFile,
    argv.key,
    argv.nonce,
  );

  const nonce = safeTransaction.data.nonce;
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
  const signed = await safeSdk.signTransaction(safeTransaction);
  const [signature] = signed.signatures.values();
  assert(signature, 'Signing did not produce a signature');

  rootLogger.info(`chain: ${txFile.chain}`);
  rootLogger.info(`safe: ${txFile.safeAddress}`);
  rootLogger.info(`nonce: ${nonce}`);
  rootLogger.info(`safeTxHash: ${safeTxHash}`);
  rootLogger.info(`signer: ${signature.signer}`);
  rootLogger.info(`signature: ${signature.data}`);

  const out: StoredSignature = {
    signer: signature.signer,
    data: signature.data,
  };
  if (argv.out) {
    await writeAndFormatJsonAtPath(argv.out, out);
    rootLogger.info(`Wrote signature to ${argv.out}`);
  } else {
    rootLogger.info(
      `Share this with whoever executes:\n${JSON.stringify(out)}`,
    );
  }
}

async function execute(argv: {
  file: string;
  key: string;
  signatures: string[];
  nonce?: number;
}) {
  const txFile = readJson<RawTxFile>(argv.file);
  const multiProvider = await buildMultiProvider();
  const { safeSdk, safeTransaction } = await loadSafeTransaction(
    multiProvider,
    txFile,
    argv.key,
    argv.nonce,
  );

  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
  rootLogger.info(`safeTxHash: ${safeTxHash}`);

  for (const sigPath of argv.signatures) {
    const { signer, data } = readJson<StoredSignature>(sigPath);
    safeTransaction.addSignature(new EthSafeSignature(signer, data));
    rootLogger.info(`Added signature from ${signer} (${sigPath})`);
  }

  const threshold = await safeSdk.getThreshold();
  assert(
    safeTransaction.signatures.size >= threshold,
    `Only ${safeTransaction.signatures.size} signature(s) collected, need ${threshold}`,
  );

  const result = await safeSdk.executeTransaction(safeTransaction);
  rootLogger.info(`Submitted execTransaction: ${result.hash}`);
}

async function main() {
  await yargs(process.argv.slice(2))
    .command(
      'sign',
      'Sign a raw Safe tx with your own key, without a tx service',
      (y) =>
        y
          .option('file', {
            type: 'string',
            demandOption: true,
            describe: 'Path to the <chain>.raw.json file',
          })
          .option('key', {
            type: 'string',
            demandOption: true,
            describe: 'Private key of a Safe owner',
          })
          .option('nonce', { type: 'number' })
          .option('out', {
            type: 'string',
            describe: 'Path to write the signature JSON to',
          }),
      (argv) => sign(argv),
    )
    .command(
      'execute',
      'Execute a raw Safe tx once enough signatures are collected',
      (y) =>
        y
          .option('file', {
            type: 'string',
            demandOption: true,
            describe: 'Path to the <chain>.raw.json file',
          })
          .option('key', {
            type: 'string',
            demandOption: true,
            describe: 'Private key of the tx executor (need not be an owner)',
          })
          .option('signatures', {
            type: 'array',
            string: true,
            demandOption: true,
            describe: 'Paths to signature JSON files, one per signer',
          })
          .option('nonce', { type: 'number' }),
      (argv) => execute(argv),
    )
    .demandCommand(1)
    .strict()
    .parse();
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
