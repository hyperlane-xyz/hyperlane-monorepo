import { TronWeb } from 'tronweb';

import DomainRoutingIsmAbi from '@hyperlane-xyz/core/tron/abi/contracts/isms/routing/DomainRoutingIsm.sol/DomainRoutingIsm.json' with { type: 'json' };
import NoopIsmAbi from '@hyperlane-xyz/core/tron/abi/contracts/isms/NoopIsm.sol/NoopIsm.json' with { type: 'json' };
import StaticMerkleRootMultisigIsmAbi from '@hyperlane-xyz/core/tron/abi/contracts/isms/multisig/StaticMultisigIsm.sol/StaticMerkleRootMultisigIsm.json' with { type: 'json' };
import StaticMessageIdMultisigIsmAbi from '@hyperlane-xyz/core/tron/abi/contracts/isms/multisig/StaticMultisigIsm.sol/StaticMessageIdMultisigIsm.json' with { type: 'json' };
import {
  buildMetaProxyBytecode,
  createDeploymentTransaction,
  createRawBytecodeDeploymentTransaction,
} from '../utils/index.js';
import { TronTransaction } from '../utils/types.js';

export async function getCreateTestIsmTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(tronweb, NoopIsmAbi, fromAddress, []);
}

/**
 * Deploys StaticMessageIdMultisigIsm implementation contract (deploy once, reuse)
 * @param tronweb - TronWeb instance
 * @param fromAddress - Deployer address
 * @returns Transaction to deploy implementation
 */
export async function getCreateMessageIdMultisigIsmImplementationTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    StaticMessageIdMultisigIsmAbi,
    fromAddress,
    [],
  );
}

/**
 * Deploys StaticMerkleRootMultisigIsm implementation contract (deploy once, reuse)
 * @param tronweb - TronWeb instance
 * @param fromAddress - Deployer address
 * @returns Transaction to deploy implementation
 */
export async function getCreateMerkleRootMultisigIsmImplementationTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    StaticMerkleRootMultisigIsmAbi,
    fromAddress,
    [],
  );
}

/**
 * Creates transaction to deploy MessageIdMultisigIsm using MetaProxy pattern
 * This embeds config in bytecode rather than constructor, enabling deterministic addresses
 * @param tronweb - TronWeb instance
 * @param fromAddress - Deployer address
 * @param implementationAddress - Address of deployed StaticMessageIdMultisigIsm implementation
 * @param config - Validators and threshold configuration
 * @returns Transaction to deploy MetaProxy ISM
 */
export async function getCreateMessageIdMultisigIsmWithMetaProxyTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  implementationAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<TronTransaction> {
  // ABI encode the metadata: (address[], uint8)
  const metadata = tronweb.utils.abi.encodeParams(
    ['address[]', 'uint8'],
    [config.validators, config.threshold],
  );

  // Build MetaProxy bytecode with embedded metadata
  const metaProxyBytecode = buildMetaProxyBytecode(
    tronweb.address.toHex(implementationAddress),
    metadata,
  );

  return createRawBytecodeDeploymentTransaction(
    tronweb,
    metaProxyBytecode,
    fromAddress,
    'StaticMessageIdMultisigIsm',
  );
}

/**
 * Creates transaction to deploy MerkleRootMultisigIsm using MetaProxy pattern
 * This embeds config in bytecode rather than constructor, enabling deterministic addresses
 * @param tronweb - TronWeb instance
 * @param fromAddress - Deployer address
 * @param implementationAddress - Address of deployed StaticMerkleRootMultisigIsm implementation
 * @param config - Validators and threshold configuration
 * @returns Transaction to deploy MetaProxy ISM
 */
export async function getCreateMerkleRootMultisigIsmWithMetaProxyTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  implementationAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<TronTransaction> {
  // ABI encode the metadata: (address[], uint8)
  const metadata = tronweb.utils.abi.encodeParams(
    ['address[]', 'uint8'],
    [config.validators, config.threshold],
  );

  // Build MetaProxy bytecode with embedded metadata
  const metaProxyBytecode = buildMetaProxyBytecode(
    tronweb.address.toHex(implementationAddress),
    metadata,
  );

  return createRawBytecodeDeploymentTransaction(
    tronweb,
    metaProxyBytecode,
    fromAddress,
    'StaticMerkleRootMultisigIsm',
  );
}

export async function getCreateRoutingIsmTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    DomainRoutingIsmAbi,
    fromAddress,
    [],
  );
}

export async function getInitRoutingIsmTx(
  tronweb: Readonly<TronWeb>,
  ownerAddress: string,
  config: {
    ismAddress: string;
    routes: { ismAddress: string; domainId: number }[];
  },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.ismAddress,
    'initialize(address,uint32[],address[])',
    {},
    [
      {
        type: 'address',
        value: ownerAddress,
      },
      {
        type: 'uint32[]',
        value: config.routes.map((r) => r.domainId),
      },
      {
        type: 'address[]',
        value: config.routes.map((r) => r.ismAddress),
      },
    ],
    tronweb.address.toHex(ownerAddress),
  );

  return transaction;
}

export async function getSetRoutingIsmRouteTx(
  tronweb: Readonly<TronWeb>,
  ownerAddress: string,
  config: {
    ismAddress: string;
    domainIsm: { domainId: number; ismAddress: string };
  },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.ismAddress,
    'set(uint32,address)',
    {},
    [
      {
        type: 'uint32',
        value: config.domainIsm.domainId,
      },
      {
        type: 'address',
        value: config.domainIsm.ismAddress,
      },
    ],
    tronweb.address.toHex(ownerAddress),
  );

  return transaction;
}

export async function getRemoveRoutingIsmRouteTx(
  tronweb: Readonly<TronWeb>,
  ownerAddress: string,
  config: { ismAddress: string; domainId: number },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.ismAddress,
    'remove(uint32)',
    {},
    [
      {
        type: 'uint32',
        value: config.domainId,
      },
    ],
    tronweb.address.toHex(ownerAddress),
  );

  return transaction;
}

export async function getSetRoutingIsmOwnerTx(
  tronweb: Readonly<TronWeb>,
  ownerAddress: string,
  config: { ismAddress: string; newOwner: string },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.ismAddress,
    'transferOwnership(address)',
    {},
    [
      {
        type: 'address',
        value: config.newOwner,
      },
    ],
    tronweb.address.toHex(ownerAddress),
  );

  return transaction;
}
