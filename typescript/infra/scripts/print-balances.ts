import { BigNumber } from 'ethers';

import { Contexts } from '../config/contexts.js';
import { Role } from '../src/roles.js';
import { isEthereumProtocolChain } from '../src/utils/utils.js';

import {
  getArgs,
  withAgentRoles,
  withChains,
  withContext,
} from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
    roles = [Role.Deployer, Role.Relayer],
  } = await withContext(withChains(withAgentRoles(getArgs()))).argv;

  const envConfig = getEnvironmentConfig(environment);
  const chainsToCheck = (
    chains?.length ? chains : envConfig.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chainsToCheck,
  );

  const balancesObject = await Promise.all(
    chainsToCheck.map(async (chain) => {
      const provider = multiProvider.getProvider(chain);
      const { decimals, symbol } = await multiProvider.getNativeToken(chain);
      const roleBalances = await Promise.all(
        roles.map(async (role) => {
          const keys = await envConfig.getKeys(context, role as Role);
          await Promise.all(Object.values(keys).map((key) => key.fetch()));
          if (keys[chain]) {
            const balance = await provider.getBalance(keys[chain].address);
            return convertToNativeTokenValue(balance, decimals);
          }
          return null;
        }),
      );
      return {
        chain,
        symbol,
        ...Object.fromEntries(
          roles.map((role, index) => [role, roleBalances[index]]),
        ),
      };
    }),
  );

  const formattedBalances = balancesObject.reduce((acc, chainData) => {
    const { chain, symbol, ...roleBalances } = chainData;
    acc[chain] = { symbol, ...roleBalances };
    return acc;
  }, {} as Record<string, any>);

  console.table(formattedBalances);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

function convertToNativeTokenValue(value: BigNumber, decimals: number): string {
  const divisor = BigNumber.from(10).pow(decimals);
  const integerPart = value.div(divisor);
  const fractionalPart = value.mod(divisor).toString().padStart(decimals, '0');
  const truncatedFractionalPart = fractionalPart.slice(0, 3);
  return `${integerPart.toString()}.${truncatedFractionalPart}`;
}
