import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { readFileAtPath } from '@hyperlane-xyz/cli/dist/src/utils/files.js';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getChain, getRegistry } from '../../config/registry.js';
import { getArgs, withWarpRouteId } from '../agent-utils.js';

async function main() {
  const { warpRouteId } = await withWarpRouteId(getArgs()).argv;
  const registry = getRegistry();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const configFileName = resolve(
    __dirname,
    `../../../../rust/sealevel/environments/mainnet3/warp-routes/${warpRouteId?.replace(/\//g, '-')}`,
  );

  const tokenConfig = JSON.parse(
    readFileAtPath(configFileName + '/token-config.json'),
  );
  const programIds = JSON.parse(
    readFileAtPath(configFileName + '/program-ids.json'),
  );

  const names = [
    ...new Set(
      Object.values(tokenConfig)
        .map((d: any) => d.name)
        .filter(Boolean),
    ),
  ];
  const symbols = [
    ...new Set(
      Object.values(tokenConfig)
        .map((d: any) => d.symbol)
        .filter(Boolean),
    ),
  ];

  if (names.length > 1 || symbols.length > 1) {
    throw new Error(`Found inconsistent names or symbols.`);
  }

  const warpCoreConfig = {
    tokens: Object.entries(tokenConfig).map(
      ([chainName, config]: [string, any]) => {
        const base = {
          chainName,
          addressOrDenom: programIds[chainName].base58,
          decimals: config.decimals,
          name: names[0],
          owner: config.owner,
          symbol: symbols[0],
        };

        if (config.type === 'collateral') {
          return {
            ...base,
            collateralAddressOrDenom: config.token,
            standard: TokenStandard.SealevelHypCollateral,
          };
        } else if (config.type === 'synthetic') {
          const chain = getChain(chainName);
          const collateralAddressOrDenom = queryMintAuthority(
            chain.rpcUrls[0].http,
            programIds[chainName].base58,
          );

          return {
            ...base,
            standard: TokenStandard.SealevelHypSynthetic,
            collateralAddressOrDenom: collateralAddressOrDenom,
          };
        } else {
          throw new Error(`Only collateral, synthetic supported: ${chainName}`);
        }
      },
    ),
  };

  const finalConfig = {
    tokens: warpCoreConfig.tokens.map((token) => {
      const connections = warpCoreConfig.tokens
        .filter((t) => t.addressOrDenom !== token.addressOrDenom)
        .map((t) => ({
          token: `sealevel|${t.chainName}|${t.addressOrDenom}`,
        }));
      return {
        ...token,
        connections,
      };
    }),
  };

  registry.addWarpRoute(finalConfig);

  // TODO: Use registry.getWarpRoutesPath() to dynamically generate path by removing "protected"
  rootLogger.info(
    `Warp config successfully created at ${registry.getUri()}/deployments/warp_routes/${warpRouteId}-deploy.yaml`,
  );
}

export function queryMintAuthority(rpcUrl: string, programId: string): string {
  const command = `cargo run -- -u ${rpcUrl} token query --program-id ${programId} synthetic`;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const clientDir = resolve(__dirname, '../../../../rust/sealevel/client');

  let output: string;
  try {
    output = execSync(command, {
      encoding: 'utf8',
      cwd: clientDir,
    });
  } catch (err: any) {
    throw new Error(`Failed to execute cargo command: ${err.message}`);
  }

  const match = output.match(
    /Mint \/ Mint Authority: ([1-9A-HJ-NP-Za-km-z]{32,44}), bump=\d+/,
  );
  if (!match) {
    throw new Error(`Mint authority not found in output:\n${output}`);
  }

  return match[1];
}

main().catch((err) => rootLogger.error('Error:', err));
