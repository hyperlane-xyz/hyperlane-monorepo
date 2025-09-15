import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

function validateDecimals(config: any): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];

  Object.entries(config).forEach(([chainName, tokenConfig]: [string, any]) => {
    // Check decimals for synthetic tokens
    if (
      tokenConfig.type === 'synthetic' ||
      tokenConfig.type === 'syntheticRebase'
    ) {
      if (tokenConfig.decimals !== undefined) {
        if (
          typeof tokenConfig.decimals !== 'number' ||
          tokenConfig.decimals <= 0
        ) {
          errors.push(
            `${chainName}: decimals must be a positive number, got ${tokenConfig.decimals}`,
          );
        } else if (tokenConfig.decimals > 18) {
          warnings.push(
            `${chainName}: decimals (${tokenConfig.decimals}) is unusually high, typically <= 18`,
          );
        }
      }
    }

    // Check gas amounts
    if (tokenConfig.gas !== undefined) {
      if (typeof tokenConfig.gas !== 'number' || tokenConfig.gas <= 0) {
        errors.push(
          `${chainName}: gas must be a positive number, got ${tokenConfig.gas}`,
        );
      } else if (tokenConfig.gas > 50000000) {
        warnings.push(
          `${chainName}: gas amount (${tokenConfig.gas}) is very high, consider if this is correct`,
        );
      }
    }

    // Check token metadata for synthetic tokens
    if (
      tokenConfig.type === 'synthetic' ||
      tokenConfig.type === 'syntheticRebase'
    ) {
      if (!tokenConfig.name) {
        errors.push(`${chainName}: 'name' is required for synthetic tokens`);
      }
      if (!tokenConfig.symbol) {
        errors.push(`${chainName}: 'symbol' is required for synthetic tokens`);
      }
    }

    // Check owner addresses format
    if (tokenConfig.owner) {
      if (typeof tokenConfig.owner !== 'string') {
        errors.push(`${chainName}: owner must be a string address`);
      } else if (!tokenConfig.owner.match(/^(0x[a-fA-F0-9]{40}|[a-z0-9_]+)$/)) {
        warnings.push(
          `${chainName}: owner address format may be invalid: ${tokenConfig.owner}`,
        );
      }
    }
  });

  return [...errors, ...warnings];
}

function validateWarpConfig(configPath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Read and parse the config file
    const configFile = readFileSync(configPath, 'utf8');
    let config: any;

    if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
      config = parseYaml(configFile);
    } else {
      config = JSON.parse(configFile);
    }

    // Basic schema validation
    const schemaValidation = WarpRouteDeployConfigSchema.safeParse(config);
    if (!schemaValidation.success) {
      schemaValidation.error.issues.forEach((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
        errors.push(`Schema validation error at ${path}: ${issue.message}`);
      });
    }

    // Custom validations
    const customValidationErrors = validateDecimals(config);
    customValidationErrors.forEach((error) => {
      if (
        error.includes('warning') ||
        error.includes('unusually') ||
        error.includes('very high') ||
        error.includes('may be invalid')
      ) {
        warnings.push(error);
      } else {
        errors.push(error);
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  } catch (error) {
    return {
      isValid: false,
      errors: [`Failed to parse config file: ${error}`],
      warnings: [],
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: ts-node validate-warp-config.ts <config-path>');
    process.exit(1);
  }

  const configPath = resolve(args[0]);
  console.log(`Validating warp route config: ${configPath}\n`);

  const result = validateWarpConfig(configPath);

  if (result.errors.length > 0) {
    console.log('❌ ERRORS:');
    result.errors.forEach((error) => console.log(`  - ${error}`));
    console.log();
  }

  if (result.warnings.length > 0) {
    console.log('⚠️  WARNINGS:');
    result.warnings.forEach((warning) => console.log(`  - ${warning}`));
    console.log();
  }

  if (result.isValid) {
    console.log('✅ Config is valid!');
    if (result.warnings.length > 0) {
      console.log('   (but please review warnings above)');
    }
    process.exit(0);
  } else {
    console.log('❌ Config has validation errors that must be fixed.');
    process.exit(1);
  }
}

if (isMainModule) {
  main();
}
