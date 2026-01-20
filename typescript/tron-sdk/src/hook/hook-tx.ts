import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import InterchainGasPaymasterAbi from '../abi/InterchainGasPaymaster.json' with { type: 'json' };
import MerkleTreeHookAbi from '../abi/MerkleTreeHook.json' with { type: 'json' };
import { createDeploymentTransaction } from '../utils/index.js';
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
      feeLimit: 100_000_000,
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
    destinationGasConfig: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
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
      feeLimit: 100_000_000,
      callValue: 0,
    },
    [
      {
        type: 'tuple(uint32 remoteDomain, tuple(address gasOracle, uint96 gasOverhead) config)[]',
        value: [
          {
            remoteDomain: Number(config.destinationGasConfig.remoteDomainId),
            config: {
              gasOracle: gasOracle.replace('41', '0x'),
              gasOverhead: config.destinationGasConfig.gasOverhead.toString(),
            },
          },
        ],
      },
    ],
    tronweb.address.toHex(fromAddress),
  );

  return transaction;
}
