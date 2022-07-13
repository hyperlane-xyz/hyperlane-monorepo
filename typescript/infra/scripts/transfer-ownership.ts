import { AbacusCore, AbacusCoreChecker } from '@abacus-network/sdk';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // environments union doesn't work well with typescript
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);

  const coreChecker = new AbacusCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();
  // 16 ownable contracts per chain.
  await coreChecker.expectViolations(['Ownable'], [7 * 16]);

  for (const violation of coreChecker.violations) {
    const chainConnection = multiProvider.getChainConnection(violation.chain);
    switch (violation.type) {
      case 'Ownable': {
        console.log(
          `${violation.chain}: transferring ownership of ${violation.data.contract.address} from ${violation.actual} to ${violation.expected}`,
        );
        const response = await violation.data.contract.transferOwnership(
          violation.expected,
          chainConnection.overrides,
        );
        await response.wait(chainConnection.confirmations);
        break;
      }
      default:
        throw new Error(`Unexpected violation type ${violation.type}`);
    }
  }
}

check().then(console.log).catch(console.error);
