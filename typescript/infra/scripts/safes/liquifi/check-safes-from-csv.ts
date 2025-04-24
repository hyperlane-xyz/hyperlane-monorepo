import { eqAddress } from '@hyperlane-xyz/utils';

import { getSafeAndService } from '../../../src/utils/safe.js';
import { getInfraPath, readFileAtPath } from '../../../src/utils/utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

const CHAIN = 'ethereum';

enum SafeConfigViolationType {
  missingOwner = 'missingOwner',
  OwnerNumberMismatch = 'OwnerNumberMismatch',
  thresholdMismatch = 'thresholdMismatch',
}

interface SafeConfigViolation {
  type: SafeConfigViolationType;
  safeAddress: string;
  expected?: string;
  actual?: string;
  description?: string;
}

const AW_OWNER = '0xc42da54b9de34e857a2ab5f79a0ca1e9b3aabd6b'; // AW turnkey signer https://hyperlaneworkspace.slack.com/archives/C08GTDG966Q/p1744781718681939?thread_ts=1744781498.877539&cid=C08GTDG966Q
const LIQUIFI_OWNER = '0x14144ac4c22931b985b8288e86f51625e1fca062'; // liquifi https://hyperlaneworkspace.slack.com/archives/C08GTHPL908/p1744732939562689
const EXPECTED_THRESHOLD = 2;
const EXPECTED_NUMBER_OF_OWNERS = 3;

const CONFIG_FILE = 'TGE2.csv';

async function main() {
  const multiProvider = await getEnvironmentConfig('mainnet3').getMultiProvider(
    undefined,
    undefined,
    true,
    [CHAIN],
  );

  const csvContent = readFileAtPath(
    `${getInfraPath()}config/environments/mainnet3/safe/liquifi/${CONFIG_FILE}`,
  );

  // csv format
  // Bucket,Sender (name),Sender (address),Recipient (name),Recipient (address),Chain,Amount,Asset,Tx Hash,Date,Notes,
  // ,AW,Abacus Works,,Employee Safe-1,0xc7fdA4359726654B40008E10344CFA594dCFcb8B,Ethereum,"200,000.00",HYPER,Sat,,
  const safeAddresses = new Set<string>();
  csvContent
    .split('\n')
    .slice(1) // Skip header
    .filter((line) => line.trim())
    .forEach((line) => {
      const [
        _bucket,
        _senderName,
        _senderAddress,
        _recipientName,
        safeAddress,
      ] = line.split(',');
      safeAddresses.add(safeAddress.trim());
    });

  const violations: SafeConfigViolation[] = [];
  for (const safeAddress of safeAddresses) {
    const { safeSdk } = await getSafeAndService(
      CHAIN,
      multiProvider,
      safeAddress,
    );

    const owners = await safeSdk.getOwners();
    const threshold = await safeSdk.getThreshold();

    // check if number of owners matche
    if (owners.length !== EXPECTED_NUMBER_OF_OWNERS) {
      violations.push({
        type: SafeConfigViolationType.OwnerNumberMismatch,
        safeAddress,
        expected: `${EXPECTED_NUMBER_OF_OWNERS}`,
        actual: `${owners.length}`,
        description: `Expected ${EXPECTED_NUMBER_OF_OWNERS} owners, found ${owners.length}`,
      });
    }

    if (threshold !== EXPECTED_THRESHOLD) {
      violations.push({
        type: SafeConfigViolationType.thresholdMismatch,
        safeAddress,
        expected: `${EXPECTED_THRESHOLD}`,
        actual: `${threshold}`,
        description: `Expected threshold ${EXPECTED_THRESHOLD}, found ${threshold}`,
      });
    }

    if (!owners.some((owner) => eqAddress(owner, AW_OWNER))) {
      violations.push({
        type: SafeConfigViolationType.missingOwner,
        safeAddress,
        description: `Missing AW owner`,
      });
    }

    if (!owners.some((owner) => eqAddress(owner, LIQUIFI_OWNER))) {
      violations.push({
        type: SafeConfigViolationType.missingOwner,
        safeAddress,
        description: `Missing Liquifi owner`,
      });
    }
  }

  if (violations.length > 0) {
    console.error(`Found ${violations.length} violations`);
    console.table(violations, [
      'safeAddress',
      'type',
      'expected',
      'actual',
      'description',
    ]);
  } else {
    console.log(`No violations found`);
  }
}

main()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
