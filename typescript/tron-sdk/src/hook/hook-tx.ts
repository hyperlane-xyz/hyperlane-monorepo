import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import InterchainGasPaymasterAbi from '../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MerkleTreeHookAbi from '../abi/MerkleTreeHook.json' with { type: 'json' };
import StorageGasOracleAbi from '../abi/StorageGasOracle.json' with { type: 'json' };
import { TRON_MAX_FEE, createDeploymentTransaction } from '../utils/index.js';
import { TronTransaction } from '../utils/types.js';

export async function getCreateMerkleTreeHookTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  mailboxAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(tronweb, MerkleTreeHookAbi, fromAddress, [
    mailboxAddress,
  ]);
}

export async function getCreateIgpTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    InterchainGasPaymasterAbi,
    fromAddress,
    [],
  );
}

export async function getInitIgpTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: {
    igpAddress: string;
  },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.igpAddress,
    'initialize(address,address)',
    {
      feeLimit: TRON_MAX_FEE,
      callValue: 0,
    },
    [
      {
        type: 'address',
        value: fromAddress,
      },
      {
        type: 'address',
        value: fromAddress,
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}

export async function getCreateOracleTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
): Promise<TronTransaction> {
  return createDeploymentTransaction(
    tronweb,
    StorageGasOracleAbi,
    fromAddress,
    [],
  );
}

export async function getSetOracleTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: {
    igpAddress: string;
    oracleAddress: string;
  },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.igpAddress,
    'setGasOracle(address)',
    {
      feeLimit: TRON_MAX_FEE,
      callValue: 0,
    },
    [
      {
        type: 'address',
        value: config.oracleAddress,
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}

export async function getSetRemoteGasTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: {
    igpAddress: string;
    destinationGasConfigs: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
    }[];
  },
): Promise<TronTransaction> {
  const igp = tronweb.contract(
    InterchainGasPaymasterAbi.abi,
    config.igpAddress,
  );

  const oracleAddress = tronweb.address.fromHex(await igp.gasOracle().call());

  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    oracleAddress,
    'setRemoteGasDataConfigs((uint32,uint128,uint128)[])',
    {
      feeLimit: TRON_MAX_FEE,
      callValue: 0,
    },
    [
      {
        type: 'tuple(uint32 remoteDomain, uint128 tokenExchangeRate, uint128 gasPrice)[]',
        value: config.destinationGasConfigs.map((c) => ({
          remoteDomain: c.remoteDomainId,
          tokenExchangeRate: c.gasOracle.tokenExchangeRate,
          gasPrice: c.gasOracle.gasPrice,
        })),
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}

export async function getSetIgpOwnerTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: {
    igpAddress: string;
    newOwner: string;
  },
): Promise<TronTransaction> {
  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.igpAddress,
    'transferOwnership(address)',
    {
      feeLimit: TRON_MAX_FEE,
      callValue: 0,
    },
    [
      {
        type: 'address',
        value: config.newOwner,
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}

export async function getSetIgpDestinationGasConfigTx(
  tronweb: Readonly<TronWeb>,
  fromAddress: string,
  config: {
    igpAddress: string;
    destinationGasConfigs: {
      remoteDomainId: number;
      gasOverhead: string;
    }[];
  },
): Promise<TronTransaction> {
  const igp = tronweb.contract(
    InterchainGasPaymasterAbi.abi,
    config.igpAddress,
  );

  const hookType = await igp.hookType().call();
  assert(
    Number(hookType) === 4,
    `hook type does not equal INTERCHAIN_GAS_PAYMASTER`,
  );

  const gasOracle = await igp.gasOracle().call();

  const { transaction } = await tronweb.transactionBuilder.triggerSmartContract(
    config.igpAddress,
    'setDestinationGasConfigs((uint32,(address,uint96))[])',
    {
      feeLimit: TRON_MAX_FEE,
      callValue: 0,
    },
    [
      {
        type: 'tuple(uint32 remoteDomain, tuple(address gasOracle, uint96 gasOverhead) config)[]',
        value: config.destinationGasConfigs.map((c) => ({
          remoteDomain: c.remoteDomainId,
          config: {
            gasOracle: gasOracle.replace('41', '0x'),
            gasOverhead: c.gasOverhead,
          },
        })),
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}
