#!/usr/bin/env tsx

import { readYamlOrJson, writeJson } from '@hyperlane-xyz/utils/fs';
import yargs from 'yargs';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import {
  getChainAddresses,
  getChainMetadata,
  getRegistry,
} from '../../config/registry.js';

import {
  buildProductionPiecewiseIcaPayloadExpectations,
  decodeProductionPiecewiseIcaPayload,
} from './decode-production-piecewise-ica-payload-lib.js';

async function main(): Promise<void> {
  const { input, output, bscTransactionsOutput } = await yargs(
    process.argv.slice(2),
  )
    .strict()
    .option('input', {
      alias: 'i',
      type: 'string',
      demandOption: true,
      describe: 'ICA file-submitter JSON or YAML payload to decode',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      describe: 'Optional JSON path for the full decoded payload',
    })
    .option('bsc-transactions-output', {
      type: 'string',
      describe:
        'Optional JSON path containing only the validated BSC transaction array for hyperlane submit',
    })
    .parseAsync();

  const registry = getRegistry();
  const usdcRoute = registry.getWarpRoute(WarpRouteIds.USDCCitreaMoonpay);
  if (!usdcRoute) throw new Error('USDC/moonpay is missing from the registry');

  const expected = buildProductionPiecewiseIcaPayloadExpectations({
    chainMetadata: getChainMetadata(),
    chainAddresses: getChainAddresses(),
    usdcRoute,
  });
  const decoded = decodeProductionPiecewiseIcaPayload(
    readYamlOrJson<unknown>(input),
    expected,
  );

  if (output) writeJson(output, decoded);
  if (bscTransactionsOutput)
    writeJson(bscTransactionsOutput, [decoded.bscTransaction]);

  console.log(JSON.stringify(decoded, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
