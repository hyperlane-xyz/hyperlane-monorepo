/**
 * Verify that all fastpath validators (AW, Enigma, Luganodes) are announced
 * on-chain for each fastpath chain.
 *
 * Usage:
 *   pnpm tsx scripts/validators/fastpath/check-fastpath-validator-announce.ts \
 *     -e mainnet3 [--chains arbitrum base ...]
 */
import { eqAddress } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import { FASTPATH_VALIDATORS } from '../../../config/environments/mainnet3/fastpath/validators.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';
import { getAgentConfig, getArgs, withChains } from '../../agent-utils.js';
import { getHyperlaneCore } from '../../core-utils.js';

type Row = {
  chain: string;
  validator: string;
  alias: string;
  announced: string;
};

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const { core } = await getHyperlaneCore(environment);

  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const targetChains = chains && chains.length > 0 ? chains : fastpathChains;

  const rows: Row[] = [];

  for (const chain of targetChains) {
    if (!isEthereumProtocolChain(chain)) continue;

    const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
    const announcedValidators =
      await validatorAnnounce.getAnnouncedValidators();

    for (const { address, alias } of FASTPATH_VALIDATORS) {
      const announced = announcedValidators.some((v) => eqAddress(v, address));
      rows.push({
        chain,
        validator: address,
        alias,
        announced: announced ? '✅' : '❌',
      });
    }
  }

  console.table(rows);

  const failures = rows.filter((r) => r.announced === '❌');
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} validator(s) not announced:`);
    failures.forEach((r) =>
      console.error(`  [${r.chain}] ${r.alias} (${r.validator})`),
    );
    process.exitCode = 1;
  } else {
    console.log('\n✅ All fastpath validators announced!');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
