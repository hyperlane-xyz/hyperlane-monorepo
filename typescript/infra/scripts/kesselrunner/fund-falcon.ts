import { formatUnits, parseUnits } from 'ethers/lib/utils.js';

import { IERC20__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  KESSEL_RUN_SPICE_ROUTE,
  MILLENNIUM_FALCON_ADDRESS,
} from '../../src/kesselrunner/config.js';
import { getKesselRunMultiProvider } from '../../src/kesselrunner/utils.js';

const EXPECTED_SPICE_BALANCE = 1;

async function loadSpiceOntoFalcon() {
  const { multiProvider } = await getKesselRunMultiProvider();

  for (const [chainName, addressOrDenom] of Object.entries(
    KESSEL_RUN_SPICE_ROUTE,
  )) {
    try {
      if (!addressOrDenom) {
        throw new Error(`No spice token address found for chain ${chainName}`);
      }

      const signer = multiProvider.getSigner(chainName);
      const { decimals } = await multiProvider.getNativeToken(chainName);
      const milleniumFalconAddress = MILLENNIUM_FALCON_ADDRESS[chainName];

      // Create IERC20 contract instance
      const spiceToken = IERC20__factory.connect(addressOrDenom, signer);

      // Check spice token balance
      const spiceBalance = await spiceToken.balanceOf(milleniumFalconAddress);
      const formattedSpiceBalance = Number(formatUnits(spiceBalance, decimals));

      if (formattedSpiceBalance < EXPECTED_SPICE_BALANCE) {
        const topUpValue = parseUnits(
          EXPECTED_SPICE_BALANCE.toString(),
          decimals,
        );
        const funderAddress = await multiProvider.getSignerAddress(chainName);
        const funderSpiceBalance = await spiceToken.balanceOf(funderAddress);

        if (funderSpiceBalance.lt(topUpValue)) {
          throw new Error(
            `Funder account has insufficient spice tokens on chain ${chainName} to load Millennium Falcon. Required: ${EXPECTED_SPICE_BALANCE}, Available: ${formatUnits(
              funderSpiceBalance,
              decimals,
            )}`,
          );
        }

        // Transfer spice tokens
        const spiceTx = await spiceToken.transfer(
          milleniumFalconAddress,
          topUpValue,
        );
        const formattedTopUpValue = formatUnits(topUpValue, decimals);
        await spiceTx.wait();
        rootLogger.info(
          `Loaded Millennium Falcon on ${chainName} with ${formattedTopUpValue} more spice tokens`,
        );
      }
    } catch (error: any) {
      rootLogger.error(
        `Error loading Millennium Falcon with spice on ${chainName}:`,
        error,
      );
    }
  }
}

loadSpiceOntoFalcon().catch((error) => {
  rootLogger.error('Error loading spice:', error);
  process.exit(1);
});
