import { constants } from 'ethers';

import {
  ERC20__factory,
  LinearFee__factory,
  ProgressiveFee__factory,
  RegressiveFee__factory,
  RoutingFee__factory,
  TransferRouter__factory,
} from '@hyperlane-xyz/core';
import {
  type MultiProvider,
  type TokenFeeConfigInput,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import type {
  TransferRouterDeployConfig,
  TransferRouterOutput,
} from '../transfer-router/types.js';

export interface TransferRouterDeployOptions {
  skipConfirmation?: boolean;
}

const logger = rootLogger.child({ module: 'TransferRouterDeploy' });

// Copied from EvmTokenFeeModule.ts:52-73 — stamps token onto fee config recursively
function resolveTokenForFeeConfig(
  config: TokenFeeConfigInput,
  token: string,
): TokenFeeConfigInput & { token: string } {
  if (
    config.type === TokenFeeType.RoutingFee &&
    'feeContracts' in config &&
    config.feeContracts
  ) {
    return {
      ...config,
      token,
      feeContracts: Object.fromEntries(
        Object.entries(config.feeContracts).map(([chain, subFee]) => [
          chain,
          resolveTokenForFeeConfig(subFee, token),
        ]),
      ),
    };
  }
  return { ...config, token };
}

const feeFactories = {
  [TokenFeeType.LinearFee]: new LinearFee__factory(),
  [TokenFeeType.ProgressiveFee]: new ProgressiveFee__factory(),
  [TokenFeeType.RegressiveFee]: new RegressiveFee__factory(),
  [TokenFeeType.RoutingFee]: new RoutingFee__factory(),
} as const;

async function deployFeeContract(
  multiProvider: MultiProvider,
  chain: string,
  token: string,
  feeInput: TokenFeeConfigInput,
): Promise<string> {
  const resolvedConfig = resolveTokenForFeeConfig(feeInput, token);

  if (resolvedConfig.type === TokenFeeType.RoutingFee) {
    const signerAddress = await multiProvider.getSignerAddress(chain);
    const routingFee = await multiProvider.handleDeploy(
      chain,
      feeFactories[TokenFeeType.RoutingFee],
      [token, signerAddress],
    );

    if ('feeContracts' in resolvedConfig && resolvedConfig.feeContracts) {
      for (const [destChain, subFeeConfig] of Object.entries(
        resolvedConfig.feeContracts,
      )) {
        const subFeeAddress = await deployFeeContract(
          multiProvider,
          chain,
          token,
          subFeeConfig as TokenFeeConfigInput,
        );
        const destDomain = multiProvider.getDomainId(destChain);
        await multiProvider.handleTx(
          chain,
          routingFee['setFeeContract(uint32,address)'](
            destDomain,
            subFeeAddress,
          ),
        );
      }
    }

    const owner = resolvedConfig.owner;
    if (owner && owner !== signerAddress) {
      await multiProvider.handleTx(chain, routingFee.transferOwnership(owner));
    }

    logger.info(`RoutingFee deployed at ${routingFee.address} on ${chain}`);
    return routingFee.address;
  }

  // LinearFee, ProgressiveFee, RegressiveFee all take [token, maxFee, halfAmount, owner]
  const { owner } = resolvedConfig;
  const maxFee =
    'maxFee' in resolvedConfig ? BigInt(resolvedConfig.maxFee!) : 0n;
  const halfAmount =
    'halfAmount' in resolvedConfig ? BigInt(resolvedConfig.halfAmount!) : 0n;

  const factory = feeFactories[resolvedConfig.type];
  const feeContract = await multiProvider.handleDeploy(chain, factory, [
    token,
    maxFee,
    halfAmount,
    owner,
  ]);

  logger.info(
    `${resolvedConfig.type} deployed at ${feeContract.address} on ${chain}`,
  );
  return feeContract.address;
}

export async function deployTransferRouters({
  config,
  multiProvider,
  options: _options,
}: {
  config: TransferRouterDeployConfig;
  multiProvider: MultiProvider;
  options: TransferRouterDeployOptions;
}): Promise<TransferRouterOutput> {
  const output: TransferRouterOutput = {};

  for (const [chain, chainConfig] of Object.entries(config)) {
    const { token, owner, fee } = chainConfig;
    logger.info(`Deploying TransferRouter on ${chain}...`);

    const provider = multiProvider.getProvider(chain);
    const erc20 = ERC20__factory.connect(token, provider);
    try {
      const decimals = await erc20.decimals();
      logger.info(
        `Token ${token} on ${chain} validated (decimals: ${decimals})`,
      );
    } catch {
      throw new Error(
        `Token ${token} on ${chain} is not a valid ERC20 (decimals() call failed)`,
      );
    }

    let feeAddress = constants.AddressZero;
    if (fee) {
      feeAddress = await deployFeeContract(multiProvider, chain, token, fee);
    }

    logger.info(
      `Deploying TransferRouter on ${chain} with token=${token}, fee=${feeAddress}, owner=${owner}`,
    );

    const transferRouterFactory = new TransferRouter__factory();
    const deployedRouter = await multiProvider.handleDeploy(
      chain,
      transferRouterFactory,
      [token, feeAddress, owner],
    );

    const routerAddress = deployedRouter.address;
    logger.info(`TransferRouter deployed at ${routerAddress} on ${chain}`);

    output[chain] = {
      transferRouter: routerAddress,
      token,
      feeContract: feeAddress,
      owner,
    };
  }

  return output;
}
