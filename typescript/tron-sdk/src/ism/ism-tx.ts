import { TronWeb } from 'tronweb';

import DomainRoutingIsmAbi from '../abi/DomainRoutingIsm.json' with { type: 'json' };
import NoopIsmAbi from '../abi/NoopIsm.json' with { type: 'json' };
import StorageMerkleRootMultisigIsmAbi from '../abi/StorageMerkleRootMultisigIsm.json' with { type: 'json' };
import StorageMessageIdMultisigIsmAbi from '../abi/StorageMessageIdMultisigIsm.json' with { type: 'json' };
import { createDeploymentTransaction } from '../utils/index.js';
import { TronTransaction } from '../utils/types.js';

export async function getCreateTestIsmTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(tronweb, NoopIsmAbi, fromAddress, []);
}

export async function getCreateMessageIdMultisigIsmTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    StorageMessageIdMultisigIsmAbi,
    fromAddress,
    [config.validators, config.threshold],
  );
}

export async function getCreateMerkleRootMultisigIsmTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: { validators: string[]; threshold: number },
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    StorageMerkleRootMultisigIsmAbi,
    fromAddress,
    [config.validators, config.threshold],
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
    {
      feeLimit: 100_000_000,
      callValue: 0,
    },
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
    {
      feeLimit: 100_000_000,
      callValue: 0,
    },
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
    {
      feeLimit: 100_000_000,
      callValue: 0,
    },
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
    {
      feeLimit: 100_000_000,
      callValue: 0,
    },
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
