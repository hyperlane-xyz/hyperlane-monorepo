import { BigNumber, Contract, ethers } from 'ethers';
import yargs from 'yargs';

import { ChainMap, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  assert,
  eqAddress,
  formatStandardHookMetadata,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { getEnvironmentConfig } from '../core-utils.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { SafeMultiSend, SignerMultiSend } from '../../src/govern/multisend.js';
import { Role } from '../../src/roles.js';

const originChain = 'ethereum';
const handoffChains = [
  'appchain',
  'lumiaprism',
  'matchain',
  'prom',
  'vana',
] as const;
type HandoffChain = (typeof handoffChains)[number];

const ownableContractNames = [
  'domainRoutingIsm',
  'fallbackRoutingHook',
  'interchainAccountRouter',
  'interchainGasPaymaster',
  'mailbox',
  'merkleTreeHook',
  'pausableHook',
  'pausableIsm',
  'protocolFee',
  'proxyAdmin',
  'storageGasOracle',
  'testRecipient',
  'validatorAnnounce',
] as const;
type OwnableContractName = (typeof ownableContractNames)[number];

const beneficiaryContractNames = new Set<OwnableContractName>([
  'interchainGasPaymaster',
  'protocolFee',
]);

const handoffs: Record<
  HandoffChain,
  { target: Address; targetType: 'eoa' | 'safe' }
> = {
  appchain: {
    target: '0x2D3Ff22F91E5f796EeE6e864AD71385B249c34A5',
    targetType: 'safe',
  },
  lumiaprism: {
    target: '0x5FE65789a7Eb447916576aF52AefF190748c08Eb',
    targetType: 'safe',
  },
  matchain: {
    target: '0x485f48CdCc2F27ACE7B4BE6398ef1dD5002b65F5',
    targetType: 'safe',
  },
  prom: {
    target: '0x65Bf3DEEbFD82ccDadadF43FB3701aEFE1d8bb00',
    targetType: 'eoa',
  },
  vana: {
    target: '0xDDF71a6ddf3FCABBbA4D607b57f0f6Fc0265bb84',
    targetType: 'safe',
  },
};

const ownableInterface = new ethers.utils.Interface([
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
]);
const beneficiaryInterface = new ethers.utils.Interface([
  'function beneficiary() view returns (address)',
  'function setBeneficiary(address beneficiary)',
]);
const safeInterface = new ethers.utils.Interface([
  'function VERSION() view returns (string)',
]);

type PlannedCall = {
  call: CallData;
  description: string;
};

function encodeCall(
  to: Address,
  iface: ethers.utils.Interface,
  functionName: string,
  values: unknown[],
): CallData {
  return {
    to,
    data: iface.encodeFunctionData(functionName, values),
    value: BigNumber.from(0),
  };
}

async function assertTargetType(
  provider: ethers.providers.Provider,
  chain: HandoffChain,
  target: Address,
  targetType: 'eoa' | 'safe',
): Promise<void> {
  const code = await provider.getCode(target);
  if (targetType === 'eoa') {
    assert(code === '0x', `[${chain}] target ${target} is not an EOA`);
    return;
  }

  assert(code !== '0x', `[${chain}] target ${target} has no contract code`);
  const safe = new Contract(target, safeInterface, provider);
  const version: string = await safe.VERSION();
  rootLogger.info(`[${chain}] target ${target} is Safe ${version}`);
}

async function main(): Promise<void> {
  const { proposeSafe, submitDeployer } = await yargs(process.argv.slice(2))
    .option('submit-deployer', {
      type: 'boolean',
      default: false,
      description: 'Submit calls for contracts currently owned by the deployer',
    })
    .option('propose-safe', {
      type: 'boolean',
      default: false,
      description:
        'Propose one Ethereum Safe MultiSend for ICA-owned contracts',
    })
    .strict()
    .parse();

  const environment = 'mainnet3';
  const environmentConfig = getEnvironmentConfig(environment);
  const multiProvider = await environmentConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [originChain, ...handoffChains],
  );
  const registry = await environmentConfig.getRegistry(true, [
    originChain,
    ...handoffChains,
  ]);
  const chainAddresses = objFilter(
    await registry.getAddresses(),
    (chain, _): _ is Record<string, string> => multiProvider.hasChain(chain),
  );
  const icaChainAddresses = objFilter(
    chainAddresses,
    (chain, _): _ is Record<string, string> =>
      !!chainAddresses[chain]?.interchainAccountRouter,
  );
  const ica = InterchainAccount.fromAddressesMap(
    icaChainAddresses,
    multiProvider,
  );

  const safeOwner = getGovernanceSafes(GovernanceType.Regular)[originChain];
  assert(safeOwner, 'Missing regular Ethereum governance Safe');
  const accountConfig = { origin: originChain, owner: safeOwner };

  const deployerCalls: ChainMap<PlannedCall[]> = {};
  const icaCalls: ChainMap<PlannedCall[]> = {};

  for (const chain of handoffChains) {
    const provider = multiProvider.getProvider(chain);
    const { target, targetType } = handoffs[chain];
    await assertTargetType(provider, chain, target, targetType);
    assert(
      (await provider.getCode(DEPLOYER)) === '0x',
      `[${chain}] deployer ${DEPLOYER} is not a plain EOA`,
    );

    const expectedIca = await ica.getAccount(chain, accountConfig);
    const addresses = chainAddresses[chain];
    assert(addresses, `[${chain}] missing registry addresses`);

    for (const name of ownableContractNames) {
      const address = addresses[name];
      assert(address, `[${chain}] missing ${name} address`);

      const contract = new Contract(address, ownableInterface, provider);
      const currentOwner: Address = await contract.owner();
      if (eqAddress(currentOwner, target)) {
        if (beneficiaryContractNames.has(name)) {
          const beneficiaryContract = new Contract(
            address,
            beneficiaryInterface,
            provider,
          );
          const beneficiary: Address = await beneficiaryContract.beneficiary();
          assert(
            eqAddress(beneficiary, target),
            `[${chain}] ${name} is already target-owned but beneficiary is ${beneficiary}`,
          );
        }
        continue;
      }

      const calls = eqAddress(currentOwner, DEPLOYER)
        ? (deployerCalls[chain] ??= [])
        : eqAddress(currentOwner, expectedIca)
          ? (icaCalls[chain] ??= [])
          : undefined;
      assert(
        calls,
        `[${chain}] ${name} has unexpected owner ${currentOwner}; expected deployer ${DEPLOYER}, ICA ${expectedIca}, or target ${target}`,
      );

      if (beneficiaryContractNames.has(name)) {
        const beneficiaryContract = new Contract(
          address,
          beneficiaryInterface,
          provider,
        );
        const beneficiary: Address = await beneficiaryContract.beneficiary();
        if (!eqAddress(beneficiary, target)) {
          calls.push({
            call: encodeCall(address, beneficiaryInterface, 'setBeneficiary', [
              target,
            ]),
            description: `[${chain}] set ${name} beneficiary to ${target}`,
          });
        }
      }

      calls.push({
        call: encodeCall(address, ownableInterface, 'transferOwnership', [
          target,
        ]),
        description: `[${chain}] transfer ${name} ownership to ${target}`,
      });
    }
  }

  for (const chain of handoffChains) {
    const direct = deployerCalls[chain] ?? [];
    const remote = icaCalls[chain] ?? [];
    rootLogger.info(
      `[${chain}] planned ${direct.length} deployer calls and ${remote.length} ICA calls`,
    );
    for (const { description } of [...direct, ...remote]) {
      rootLogger.info(`- ${description}`);
    }
  }

  if (!submitDeployer && !proposeSafe) {
    rootLogger.info(
      'Dry run only; pass --submit-deployer and/or --propose-safe',
    );
    return;
  }

  if (submitDeployer) {
    for (const chain of handoffChains) {
      const calls = deployerCalls[chain] ?? [];
      if (calls.length === 0) continue;
      rootLogger.info(`[${chain}] submitting ${calls.length} deployer calls`);
      await new SignerMultiSend(multiProvider, chain).sendTransactions(
        calls.map(({ call }) => call),
      );
    }
  }

  if (proposeSafe) {
    const remoteCalls: CallData[] = [];
    for (const chain of handoffChains) {
      const plannedCalls = icaCalls[chain] ?? [];
      if (plannedCalls.length === 0) continue;
      const innerCalls = plannedCalls.map(({ call }) => ({
        to: call.to,
        data: call.data,
        value: call.value?.toString() ?? '0',
      }));
      const gasLimit = await ica.estimateIcaHandleGas({
        origin: originChain,
        destination: chain,
        innerCalls,
        config: accountConfig,
      });
      const hookMetadata = formatStandardHookMetadata({
        gasLimit: gasLimit.toBigInt(),
        refundAddress: safeOwner,
      });
      const callRemote = await ica.getCallRemote({
        chain: originChain,
        destination: chain,
        innerCalls,
        config: accountConfig,
        hookMetadata,
      });
      assert(
        callRemote.to && callRemote.data,
        `[${chain}] failed to build ICA call`,
      );
      remoteCalls.push({
        to: callRemote.to,
        data: callRemote.data,
        value: callRemote.value ?? BigNumber.from(0),
      });
    }

    if (remoteCalls.length > 0) {
      const safeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        originChain,
        safeOwner,
      );
      const hashes = await safeMultiSend.sendTransactions(remoteCalls);
      rootLogger.info(`Proposed Safe transaction(s): ${hashes.join(', ')}`);
    }
  }
}

main().catch((error: unknown) => {
  rootLogger.error(error);
  process.exit(1);
});
