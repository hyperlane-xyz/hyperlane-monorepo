import { formatUnits } from 'ethers/lib/utils.js';

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

const MainnetDeployer = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const MainnetRelayer = '0x74Cae0ECC47B02Ed9B9D32E000Fd70B9417970C5';
const TestnetDeployer = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
const TestnetRelayer = '0x16626cd24fd1f228a031e48b77602ae25f8930db';

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
      try {
        const provider = multiProvider.getProvider(chain);
        const { decimals, symbol } = await multiProvider.getNativeToken(chain);
        const roleBalances = await Promise.all(
          roles.map(async (role) => {
            try {
              let address: string | undefined;

              if (
                role === Role.Deployer &&
                (environment === 'mainnet3' || environment === 'testnet4')
              ) {
                address =
                  environment === 'mainnet3'
                    ? MainnetDeployer
                    : TestnetDeployer;
              } else if (
                role === Role.Relayer &&
                (environment === 'mainnet3' || environment === 'testnet4')
              ) {
                address =
                  environment === 'mainnet3' ? MainnetRelayer : TestnetRelayer;
              } else {
                // Fetch key only if role is not deployer/relayer or env is not mainnet/testnet
                const keys = await envConfig.getKeys(context, role as Role);
                await Promise.all(
                  Object.values(keys).map((key) => key.fetch()),
                );
                address = keys[chain]?.address;
              }

              // Fetch balance
              if (address) {
                const balance = await provider.getBalance(address);
                const formattedBalance = formatUnits(balance, decimals);
                return Number(formattedBalance).toFixed(3);
              }
              return null;
            } catch (error) {
              console.error(
                `Error fetching balance for ${role} on ${chain}:`,
                error,
              );
              return null;
            }
          }),
        );
        return {
          chain,
          symbol,
          ...Object.fromEntries(
            roles.map((role, index) => [role, roleBalances[index]]),
          ),
        };
      } catch (error) {
        console.error(`Error processing chain ${chain}:`, error);
        return {
          chain,
          symbol: 'ERROR',
          ...Object.fromEntries(roles.map((role) => [role, null])),
        };
      }
    }),
  );

  const formattedBalances = balancesObject.reduce(
    (acc, chainData) => {
      const { chain, symbol, ...roleBalances } = chainData;
      acc[chain] = { symbol, ...roleBalances };
      return acc;
    },
    {} as Record<string, any>,
  );

  console.table(formattedBalances);
  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
