import { BigNumber, Wallet, constants, utils } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, assert, objMerge } from '@hyperlane-xyz/utils';

import { describeError } from '../aggregation-hook-upgrade/redact.js';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
export const REDACTED_KEY = '<redacted-key>';

// The environment variable name is the only thing taken from the command line,
// and no message below repeats a value, so a key typed in its place stays out
// of the output.
export function loadWalletFromEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Wallet {
  assert(
    !PRIVATE_KEY_PATTERN.test(name) && ENV_NAME_PATTERN.test(name),
    '--key-env takes the name of an environment variable holding the key, not the key itself',
  );
  const value = env[name];
  assert(value !== undefined && value !== '', `${name} is not set`);
  assert(
    PRIVATE_KEY_PATTERN.test(value),
    `${name} does not hold a 32-byte hex private key`,
  );
  return new Wallet(value);
}

export function createKeyRedactor(
  wallet: Wallet | undefined,
): (text: string) => string {
  if (wallet === undefined) return (text) => text;
  const key = new RegExp(`(?:0x)?${wallet.privateKey.slice(2)}`, 'gi');
  return (text) => text.replace(key, REDACTED_KEY);
}

export function describeIcaError(
  error: unknown,
  redact: (text: string) => string,
): string {
  return redact(describeError(error));
}

export interface PriorityFeeProvider {
  multiProvider: MultiProvider;
  // Chains whose metadata pins a fee keep it: the pin is the operator's
  // inclusion guarantee for that chain.
  pinned: ChainName[];
}

// Fee parameters fixed for the run from the base fee at the time of the call:
// a set tip and a ceiling of twice the base fee above it, so the balance the
// node demands up front tracks what is really spent. The ceiling does not
// follow later base fee rises, so the run has to start promptly.
export async function withPriorityFee(
  multiProvider: MultiProvider,
  chains: ChainName[],
  priorityFee: BigNumber,
): Promise<PriorityFeeProvider> {
  const overrides: Record<string, { transactionOverrides: object }> = {};
  const pinned: ChainName[] = [];
  for (const chain of chains) {
    const current = multiProvider.getChainMetadata(chain).transactionOverrides;
    if (
      current?.maxFeePerGas !== undefined ||
      current?.gasPrice !== undefined
    ) {
      pinned.push(chain);
      continue;
    }
    const block = await multiProvider.getProvider(chain).getBlock('latest');
    if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) {
      continue;
    }
    // extendChainMetadata replaces the whole transactionOverrides object, so
    // the other keys (gas limits) are carried into the new one.
    overrides[chain] = {
      transactionOverrides: objMerge(current ?? {}, {
        maxFeePerGas: block.baseFeePerGas.mul(2).add(priorityFee).toString(),
        maxPriorityFeePerGas: priorityFee.toString(),
      }),
    };
  }
  const extended = multiProvider.extendChainMetadata(overrides);
  // A MultiProvider built with signers loses them when its metadata is
  // extended, so they are carried over.
  for (const chain of chains) {
    const signer = multiProvider.tryGetSigner(chain);
    if (signer) extended.setSigner(chain, signer);
  }
  return { multiProvider: extended, pinned };
}

export function parsePriorityFeeGwei(value: string): BigNumber {
  assert(
    /^\d+(\.\d{1,9})?$/.test(value),
    '--priority-fee-gwei must be a non-negative decimal number of gwei',
  );
  return utils.parseUnits(value, 9);
}

export function parseOwner(value: string): Address {
  assert(utils.isAddress(value), '--owner must be an EVM address');
  const owner = utils.getAddress(value);
  assert(
    owner !== constants.AddressZero,
    '--owner must not be the zero address',
  );
  return owner;
}
