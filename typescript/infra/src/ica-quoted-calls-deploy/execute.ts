import { constants, utils } from 'ethers';

import {
  InterchainAccountRouter__factory,
  QuotedCalls__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  ContractVerificationInput,
  MultiProvider,
  PERMIT2_ADDRESS,
  verificationUtils,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addBufferToGasLimit,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../config/environments/utils.js';
import { describeError } from '../aggregation-hook-upgrade/redact.js';

import { COMMIT_TX_GAS_USAGE, PeerDomain } from './types.js';

const ROUTER_CONTRACT = 'InterchainAccountRouter';
const QUOTED_CALLS_CONTRACT = 'QuotedCalls';

export interface DeployedContract {
  address: Address;
  // The address the deploy was expected to create, known before it was sent.
  predictedAddress: Address;
  deployTxHash: string;
  verificationInput: ContractVerificationInput;
}

export interface PendingDeploy {
  address: Address;
  signer: Address;
  nonce: number;
}

export interface DeployHooks {
  // Called before the transaction is sent, with the address it will create.
  onPending(pending: PendingDeploy): Promise<void>;
  // Called when the deploy failed and no transaction reached the node.
  onNotSent(): Promise<void>;
}

// A deploy that times out while waiting for confirmation may still mine, and
// then its address is the only handle to the contract. The address of a CREATE
// is fixed by the signer and its nonce, so it is recorded before sending. It
// holds while no other transaction of the signer is sent on the chain meanwhile.
async function deployTracked(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  hooks: DeployHooks;
  deploy: () => Promise<Omit<DeployedContract, 'predictedAddress'>>;
}): Promise<DeployedContract> {
  const signer = args.multiProvider.getSigner(args.chain);
  const from = await signer.getAddress();
  const nonce = await signer.getTransactionCount('pending');
  const predictedAddress = utils.getContractAddress({ from, nonce });
  await args.hooks.onPending({
    address: predictedAddress,
    signer: from,
    nonce,
  });
  try {
    const deployed = await args.deploy();
    return {
      address: deployed.address,
      predictedAddress,
      deployTxHash: deployed.deployTxHash,
      verificationInput: deployed.verificationInput,
    };
  } catch (error: unknown) {
    if ((await signer.getTransactionCount('pending')) === nonce) {
      try {
        await args.hooks.onNotSent();
      } catch (clearError: unknown) {
        throw new Error(
          `${describeError(error)}; the pending deploy record could not be cleared: ${describeError(clearError)}`,
        );
      }
    }
    throw error;
  }
}

// Everything after a deploy tx must keep the new address in the error, since
// it is the only handle to a contract that is otherwise unrecorded.
export async function afterDeploy<T>(
  label: string,
  chain: ChainName,
  address: Address,
  step: () => Promise<T>,
  redact: (text: string) => string,
): Promise<T> {
  try {
    return await step();
  } catch (error: unknown) {
    throw new Error(
      `${label} ${address} was deployed on ${chain} but a later step failed: ${redact(describeError(error))}`,
    );
  }
}

export async function deployRouter(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  mailbox: Address;
  owner: Address;
  hooks: DeployHooks;
}): Promise<DeployedContract> {
  const { multiProvider, chain } = args;
  const factory = new InterchainAccountRouter__factory();
  return deployTracked({
    multiProvider,
    chain,
    hooks: args.hooks,
    deploy: async () => {
      const router = await multiProvider.handleDeploy(chain, factory, [
        args.mailbox,
        constants.AddressZero,
        args.owner,
        COMMIT_TX_GAS_USAGE,
        DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
      ]);
      return {
        address: router.address,
        deployTxHash: router.deployTransaction.hash,
        verificationInput: verificationUtils.getContractVerificationInput({
          name: ROUTER_CONTRACT,
          contract: router,
          bytecode: factory.bytecode,
        }),
      };
    },
  });
}

export async function deployQuotedCalls(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  hooks: DeployHooks;
}): Promise<DeployedContract> {
  const { multiProvider, chain } = args;
  const factory = new QuotedCalls__factory();
  return deployTracked({
    multiProvider,
    chain,
    hooks: args.hooks,
    deploy: async () => {
      const quotedCalls = await multiProvider.handleDeploy(chain, factory, [
        PERMIT2_ADDRESS,
      ]);
      return {
        address: quotedCalls.address,
        deployTxHash: quotedCalls.deployTransaction.hash,
        verificationInput: verificationUtils.getContractVerificationInput({
          name: QUOTED_CALLS_CONTRACT,
          contract: quotedCalls,
          bytecode: factory.bytecode,
        }),
      };
    },
  });
}

function connectRouter(
  multiProvider: MultiProvider,
  chain: ChainName,
  router: Address,
) {
  return InterchainAccountRouter__factory.connect(
    router,
    multiProvider.getSigner(chain),
  );
}

export async function sendSetHook(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  router: Address;
  hook: Address;
}): Promise<void> {
  const { multiProvider, chain, hook } = args;
  const router = connectRouter(multiProvider, chain, args.router);
  const gas = await router.estimateGas.setHook(hook);
  await multiProvider.handleTx(
    chain,
    router.setHook(hook, {
      gasLimit: addBufferToGasLimit(gas),
      ...multiProvider.getTransactionOverrides(chain),
    }),
  );
}

export async function sendApproval(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  router: Address;
  feeToken: Address;
  spender: Address;
}): Promise<void> {
  const { multiProvider, chain, feeToken, spender } = args;
  const router = connectRouter(multiProvider, chain, args.router);
  const gas = await router.estimateGas.approveFeeTokenForHook(
    feeToken,
    spender,
  );
  await multiProvider.handleTx(
    chain,
    router.approveFeeTokenForHook(feeToken, spender, {
      gasLimit: addBufferToGasLimit(gas),
      ...multiProvider.getTransactionOverrides(chain),
    }),
  );
}

export async function sendEnrollments(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  router: Address;
  enroll: Array<{ peer: PeerDomain; router: Address }>;
}): Promise<void> {
  const { multiProvider, chain, enroll } = args;
  const router = connectRouter(multiProvider, chain, args.router);
  const domains = enroll.map(({ peer }) => peer.domainId);
  const routers = enroll.map((entry) => addressToBytes32(entry.router));
  const gas = await router.estimateGas.enrollRemoteRouters(domains, routers);
  await multiProvider.handleTx(
    chain,
    router.enrollRemoteRouters(domains, routers, {
      gasLimit: addBufferToGasLimit(gas),
      ...multiProvider.getTransactionOverrides(chain),
    }),
  );
}

export async function sendTransferOwnership(args: {
  multiProvider: MultiProvider;
  chain: ChainName;
  router: Address;
  owner: Address;
}): Promise<void> {
  const { multiProvider, chain, owner } = args;
  const router = connectRouter(multiProvider, chain, args.router);
  const gas = await router.estimateGas.transferOwnership(owner);
  await multiProvider.handleTx(
    chain,
    router.transferOwnership(owner, {
      gasLimit: addBufferToGasLimit(gas),
      ...multiProvider.getTransactionOverrides(chain),
    }),
  );
}
