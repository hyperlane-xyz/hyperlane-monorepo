import { TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { log, logBlue, logGreen, warnYellow } from '../logger.js';

/**
 * Validate privacy warp route configuration
 */
export function validatePrivacyWarpConfig(warpDeployConfig: any): void {
  const privacyTypes = [
    TokenType.privateNative,
    TokenType.privateCollateral,
    TokenType.privateSynthetic,
  ];

  const privacyChains = Object.entries(warpDeployConfig).filter(
    ([_, config]: [string, any]) => privacyTypes.includes(config.type),
  );

  if (privacyChains.length === 0) {
    return; // Not a privacy route
  }

  logBlue('\n🔐 Validating privacy warp route configuration...');

  // All chains must use privacy types
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    const cfg: any = config;
    assert(
      privacyTypes.includes(cfg.type),
      `Chain ${chain} must use a privacy token type (privateNative, privateCollateral, or privateSynthetic)`,
    );
  }

  // Check for Aleo privacy hub configuration
  const hasAleoConfig = Object.values(warpDeployConfig).some(
    (config: any) => config.privacyHubAddress,
  );

  if (!hasAleoConfig) {
    warnYellow(
      '⚠️  No Aleo privacy hub address configured. You will need to set this before deployment.',
    );
    log('\nPrivacy hub address should be set in the deployment config:');
    log('  privacyHubAddress: "privacy_hub.aleo"');
  }

  // Validate proxy deployment
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    const cfg: any = config;

    // Privacy routes should be deployed as upgradeable proxies
    if (!cfg.isUpgradeable) {
      warnYellow(
        `⚠️  Chain ${chain}: Privacy routes should be upgradeable. Consider setting isUpgradeable: true`,
      );
    }
  }

  logGreen('✓ Privacy configuration validated');
}

/**
 * Display privacy deployment notes
 */
export function displayPrivacyDeploymentNotes(): void {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logBlue('\n📋 Privacy Warp Route Deployment Notes:\n');
  log('1. Contracts will be deployed as TransparentUpgradeableProxy');
  log('2. Ensure Aleo privacy hub is deployed and configured');
  log('3. Users must register before using privacy routes:');
  log('   hyperlane warp privacy-register --chain <chain>');
  log('4. Privacy features:');
  log('   • Amount privacy on Aleo (encrypted records)');
  log('   • No sender-recipient link on-chain');
  log('   • User-controlled forwarding timing');
  log('5. Gas overhead: ~150k (higher than standard routes)');
  log('\nSecurity considerations:');
  log('   • 7-day expiry for unforwarded transfers');
  log('   • Commitment-based replay protection');
  log('   • Nonce-based uniqueness guarantees');
}

/**
 * Check if configuration uses privacy types
 */
export function isPrivacyRoute(warpDeployConfig: any): boolean {
  const privacyTypes = [
    TokenType.privateNative,
    TokenType.privateCollateral,
    TokenType.privateSynthetic,
  ];

  return Object.values(warpDeployConfig).some((config: any) =>
    privacyTypes.includes(config.type),
  );
}

/**
 * Get privacy-specific deployment parameters
 */
export function getPrivacyDeploymentParams(warpDeployConfig: any): {
  requiresProxy: boolean;
  requiresAleoHub: boolean;
  gasOverhead: number;
} {
  const isPrivacy = isPrivacyRoute(warpDeployConfig);

  if (!isPrivacy) {
    return {
      requiresProxy: false,
      requiresAleoHub: false,
      gasOverhead: 0,
    };
  }

  return {
    requiresProxy: true,
    requiresAleoHub: true,
    gasOverhead: 150_000, // Higher gas for privacy routing
  };
}
