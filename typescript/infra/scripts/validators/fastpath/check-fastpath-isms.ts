/**
 * Verify deployed fastpath messageId multisig ISMs on each destination chain.
 * Reads each ISM's on-chain validators and threshold.
 *
 * Usage:
 *   pnpm tsx scripts/validators/fastpath/check-fastpath-isms.ts \
 *     -e mainnet3 \
 *     --ismsFile config/environments/mainnet3/fastpath/isms.json \
 *     [--chains arbitrum base ...]
 */
import { ethers } from 'ethers';
import path from 'path';
import { Gauge, Registry } from 'prom-client';
import { pathToFileURL } from 'url';

import {
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
} from '@hyperlane-xyz/core';
import { submitMetrics } from '@hyperlane-xyz/metrics';
import { ModuleType } from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../../config/contexts.js';
import { DeployEnvironment } from '../../../src/config/deploy-environment.js';
import { getInfraPath } from '../../../src/utils/utils.js';
import {
  checkerViolationGroupings,
  getCheckerViolationsGaugeObj,
} from '../../check/check-utils.js';
import {
  getAgentConfig,
  getArgs as getBaseArgs,
  withChains,
} from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

// Fastpath validator addresses (AW, Enigma, Luganodes)
const AW_FASTPATH_VALIDATOR = '0xa9c4c16a4e2cf4628e1bb045cfee9de2f1c3c24a';
const ENIGMA_FASTPATH_VALIDATOR = '0x93911a19cd8914220f6287d515187e7751817683';
const LUGANODES_FASTPATH_VALIDATOR =
  '0xf9c6519dbd9a42bc6a60ea8daec3fa3830f40241';
const DEFAULT_FASTPATH_VALIDATORS = [
  AW_FASTPATH_VALIDATOR,
  ENIGMA_FASTPATH_VALIDATOR,
  LUGANODES_FASTPATH_VALIDATOR,
];
const DEFAULT_FASTPATH_THRESHOLD = 2;

// Non-zero dummy address — avoids the addressToBytes zero-check in formatMessage.
const DUMMY_ADDRESS_BYTES32 = ethers.utils.hexZeroPad('0x01', 32);

export type FastpathIsmViolationType =
  | 'missing'
  | 'moduleType'
  | 'validators'
  | 'threshold';

export type FastpathIsmCheckStatus = 'ok' | 'missing' | 'mismatch' | 'error';

export interface FastpathIsmViolation {
  actual: string;
  destination: string;
  expected: string;
  type: FastpathIsmViolationType;
}

export interface FastpathIsmCheckResult {
  actualThreshold?: number;
  actualValidators: string[];
  destination: string;
  expectedThreshold: number;
  expectedValidators: string[];
  ismAddress: string;
  moduleType?: number;
  status: FastpathIsmCheckStatus;
  violations: FastpathIsmViolation[];
}

export interface FastpathIsmChecksOptions {
  chains?: string[];
  environment: DeployEnvironment;
  ismsFile?: string;
  pushMetrics?: boolean;
}

export interface FastpathIsmChecksResult {
  erroredCount: number;
  results: FastpathIsmCheckResult[];
  violations: FastpathIsmViolation[];
  violationsCount: number;
}

function buildDummyMessage(originDomain: number, destDomain: number): string {
  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      0,
      0,
      originDomain,
      DUMMY_ADDRESS_BYTES32,
      destDomain,
      DUMMY_ADDRESS_BYTES32,
      '0x',
    ],
  );
}

function getArgs() {
  return withChains(getBaseArgs())
    .describe('ismsFile', 'path to JSON file mapping chain -> ISM address')
    .string('ismsFile')
    .demandOption('ismsFile')
    .alias('f', 'ismsFile');
}

type IsmRow = {
  destination: string;
  ismAddress: string;
  validators: string;
  threshold: number;
  ok: string;
};

async function main() {
  const { environment, chains, ismsFile } = await getArgs().argv;

  const checkResult = await runFastpathIsmChecks({
    chains,
    environment,
    ismsFile,
  });

  logFastpathIsmCheckResults(checkResult.results);

  if (checkResult.results.length === 0) {
    rootLogger.error('No ISM checks completed');
    process.exitCode = 1;
    return;
  }

  if (checkResult.violationsCount > 0 || checkResult.erroredCount > 0) {
    rootLogger.error(
      {
        erroredCount: checkResult.erroredCount,
        violationsCount: checkResult.violationsCount,
      },
      'Some ISMs failed checks',
    );
    process.exitCode = 1;
  } else {
    rootLogger.info('All ISMs ok ✅');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

export async function runFastpathIsmChecks({
  chains,
  environment,
  ismsFile,
  pushMetrics = false,
}: FastpathIsmChecksOptions): Promise<FastpathIsmChecksResult> {
  const resolvedIsmsFile =
    ismsFile ?? path.join(getInfraPath(), getFastpathIsmsFile(environment));
  const ismAddresses = readJson<Record<string, string>>(resolvedIsmsFile);

  // Expected destinations come from the fastpath agent config, not from the
  // artifact being checked: a truncated isms.json must fail the missing
  // chain, not silently drop it from the checked set.
  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const destinations = chains && chains.length > 0 ? chains : fastpathChains;

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  const results: FastpathIsmCheckResult[] = [];

  for (const destination of destinations) {
    const ismAddress = ismAddresses[destination];
    if (!ismAddress) {
      rootLogger.warn({ destination }, 'No ISM address found');
      results.push({
        actualValidators: [],
        destination,
        expectedThreshold: DEFAULT_FASTPATH_THRESHOLD,
        expectedValidators: DEFAULT_FASTPATH_VALIDATORS,
        ismAddress: '',
        status: 'missing',
        violations: [
          {
            actual: '',
            destination,
            expected: 'configured ISM address',
            type: 'missing',
          },
        ],
      });
      continue;
    }

    // Isolate per-destination on-chain failures: a transient RPC error on one
    // destination must not discard mismatches already collected for others, nor
    // prevent them from reaching PushGateway. The destination is recorded as
    // errored so the overall check still exits non-zero.
    try {
      const provider = multiProvider.getProvider(destination);
      const destDomain = multiProvider.getDomainId(destination);
      // Static ISMs ignore message content — any origin domain works.
      const dummyMsg = buildDummyMessage(1, destDomain);

      const topIsm = IInterchainSecurityModule__factory.connect(
        ismAddress,
        provider,
      );
      const moduleType = await topIsm.moduleType();

      if (moduleType !== ModuleType.MESSAGE_ID_MULTISIG) {
        rootLogger.warn(
          { destination, ismAddress, moduleType },
          'Expected messageId multisig ISM',
        );
        results.push({
          actualValidators: [],
          destination,
          expectedThreshold: DEFAULT_FASTPATH_THRESHOLD,
          expectedValidators: DEFAULT_FASTPATH_VALIDATORS,
          ismAddress,
          moduleType,
          status: 'mismatch',
          violations: [
            {
              actual: String(moduleType),
              destination,
              expected: String(ModuleType.MESSAGE_ID_MULTISIG),
              type: 'moduleType',
            },
          ],
        });
        continue;
      }

      const multisigIsm = IMultisigIsm__factory.connect(ismAddress, provider);
      const [validators, threshold] =
        await multisigIsm.validatorsAndThreshold(dummyMsg);

      const validatorsMatch =
        validators.length === DEFAULT_FASTPATH_VALIDATORS.length &&
        DEFAULT_FASTPATH_VALIDATORS.every((v) =>
          validators.some((w) => w.toLowerCase() === v.toLowerCase()),
        );
      const thresholdMatch = threshold === DEFAULT_FASTPATH_THRESHOLD;
      const violations: FastpathIsmViolation[] = [];
      if (!validatorsMatch) {
        violations.push({
          actual: validators.join(', '),
          destination,
          expected: DEFAULT_FASTPATH_VALIDATORS.join(', '),
          type: 'validators',
        });
      }
      if (!thresholdMatch) {
        violations.push({
          actual: String(threshold),
          destination,
          expected: String(DEFAULT_FASTPATH_THRESHOLD),
          type: 'threshold',
        });
      }
      results.push({
        actualThreshold: threshold,
        actualValidators: [...validators],
        destination,
        expectedThreshold: DEFAULT_FASTPATH_THRESHOLD,
        expectedValidators: DEFAULT_FASTPATH_VALIDATORS,
        ismAddress,
        moduleType,
        status: violations.length === 0 ? 'ok' : 'mismatch',
        violations,
      });

      rootLogger.info({ destination }, 'MessageId multisig ISM checked');
    } catch (error) {
      rootLogger.error(
        { destination, ismAddress, error },
        'Failed to check fastpath ISM',
      );
      results.push({
        actualValidators: [],
        destination,
        expectedThreshold: DEFAULT_FASTPATH_THRESHOLD,
        expectedValidators: DEFAULT_FASTPATH_VALIDATORS,
        ismAddress,
        status: 'error',
        violations: [],
      });
    }
  }

  const violations = results.flatMap((result) => result.violations);
  const erroredCount = results.filter(
    (result) => result.status === 'error',
  ).length;
  if (pushMetrics && violations.length > 0) {
    await pushFastpathIsmViolationMetrics(violations, environment);
  }

  return {
    erroredCount,
    results,
    violations,
    violationsCount: violations.length,
  };
}

function getFastpathIsmsFile(environment: DeployEnvironment): string {
  return path.join(
    'config',
    'environments',
    environment,
    'fastpath',
    'isms.json',
  );
}

function logFastpathIsmCheckResults(results: FastpathIsmCheckResult[]) {
  const rows: IsmRow[] = results.map((result) => ({
    destination: result.destination,
    ismAddress: result.ismAddress,
    ok: result.status === 'ok' ? '✅' : '❌',
    threshold: result.actualThreshold ?? 0,
    validators: result.actualValidators.join(', '),
  }));

  console.table(rows);
}

async function pushFastpathIsmViolationMetrics(
  violations: FastpathIsmViolation[],
  environment: DeployEnvironment,
) {
  assert(violations.length > 0, 'No fastpath ISM violations to push');

  for (const violation of violations) {
    const register = new Registry();
    const gauge = new Gauge(getCheckerViolationsGaugeObj(register));
    register.registerMetric(gauge);
    gauge
      .labels({
        actual: violation.actual,
        chain: violation.destination,
        contract_name: 'ism',
        expected: violation.expected,
        module: 'fastpath-ism',
        remote: '',
        sub_type: '',
        type: violation.type,
        warp_route_id: '',
      })
      .set(1);

    const groupings = checkerViolationGroupings([
      'fastpath-ism',
      violation.destination,
      'ism',
      violation.type,
    ]);

    await submitMetrics(register, `fastpath-isms-${environment}`, {
      groupings,
      overwriteAllMetrics: true,
    });
    rootLogger.info(
      {
        destination: violation.destination,
        type: violation.type,
      },
      'Fastpath ISM violation pushed to metrics',
    );
  }
}
