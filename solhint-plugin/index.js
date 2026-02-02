// https://protofire.github.io/solhint/docs/writing-plugins.html
class NoVirtualOverrideAllowed {
  constructor(reporter, config) {
    this.ruleId = 'no-virtual-override';

    this.reporter = reporter;
    this.config = config;
  }

  FunctionDefinition(ctx) {
    const isVirtual = ctx.isVirtual;
    const hasOverride = ctx.override !== null;

    if (isVirtual && hasOverride) {
      this.reporter.error(
        ctx,
        this.ruleId,
        'Functions cannot be "virtual" and "override" at the same time',
      );
    }
  }
}

class NoVirtualInitializerAllowed {
  constructor(reporter, config) {
    this.ruleId = 'no-virtual-initializer';

    this.reporter = reporter;
    this.config = config;
  }

  FunctionDefinition(ctx) {
    const isVirtual = ctx.isVirtual;
    const hasInitializer = ctx.modifiers.some(
      (modifier) => modifier.name === 'initializer',
    );

    if (isVirtual && hasInitializer) {
      this.reporter.error(
        ctx,
        this.ruleId,
        'Functions cannot be "virtual" and "initializer" at the same time',
      );
    }
  }
}

/**
 * Rule to ensure domain mappings (mapping(uint32 => ...)) are enumerable.
 * Contracts with domain mappings should inherit from EnumerableDomainSet
 * or use EnumerableMapExtended for proper domain tracking.
 *
 * Detection checks if the contract:
 * - Inherits from EnumerableDomainSet (directly or transitively within file)
 * - Uses EnumerableMapExtended library
 * - Has a domains() function
 *
 * Use solhint-disable-next-line to exempt specific contracts with explanation.
 */
class EnumerableDomainMapping {
  constructor(reporter, config) {
    this.ruleId = 'enumerable-domain-mapping';
    this.reporter = reporter;
    this.config = config;

    // File-level tracking for transitive inheritance
    this.contractEnumerableSupport = new Map(); // contractName -> boolean
  }

  // Reset state for each file
  SourceUnit(ctx) {
    this.contractEnumerableSupport = new Map();
  }

  // Track contract state
  ContractDefinition(ctx) {
    this.currentContractName = ctx.name;
    this.currentContractCtx = ctx;
    this.currentContractHasDomainMapping = false;
    this.currentContractHasEnumerableSupport = false;
    this.currentContractBases = [];

    // Collect base contract names and check for direct EnumerableDomainSet inheritance
    if (ctx.baseContracts) {
      for (const base of ctx.baseContracts) {
        const baseName = base.baseName?.namePath;
        if (baseName) {
          this.currentContractBases.push(baseName);
          if (baseName === 'EnumerableDomainSet') {
            this.currentContractHasEnumerableSupport = true;
          }
        }
      }
    }
  }

  // Check for using statements with EnumerableMapExtended
  UsingForDeclaration(ctx) {
    if (ctx.libraryName === 'EnumerableMapExtended') {
      this.currentContractHasEnumerableSupport = true;
    }
  }

  // Check for domains() function which indicates enumerable support
  FunctionDefinition(ctx) {
    if (ctx.name === 'domains') {
      this.currentContractHasEnumerableSupport = true;
    }
  }

  // Check for domain mappings (mapping with uint32 key)
  StateVariableDeclaration(ctx) {
    const typeName = ctx.variables?.[0]?.typeName;
    if (typeName?.type === 'Mapping') {
      const keyType = typeName.keyType;
      if (
        keyType?.type === 'ElementaryTypeName' &&
        keyType?.name === 'uint32'
      ) {
        this.currentContractHasDomainMapping = true;
      }
    }
  }

  // Check transitive inheritance and report at end of each contract
  'ContractDefinition:exit'(ctx) {
    // Check transitive inheritance from contracts defined earlier in this file
    if (!this.currentContractHasEnumerableSupport) {
      for (const baseName of this.currentContractBases) {
        if (this.contractEnumerableSupport.get(baseName)) {
          this.currentContractHasEnumerableSupport = true;
          break;
        }
      }
    }

    // Store this contract's enumerable support status for later contracts
    this.contractEnumerableSupport.set(
      this.currentContractName,
      this.currentContractHasEnumerableSupport,
    );

    // Report if contract has domain mapping but no enumerable support
    if (
      this.currentContractHasDomainMapping &&
      !this.currentContractHasEnumerableSupport
    ) {
      this.reporter.error(
        ctx,
        this.ruleId,
        `Contract "${this.currentContractName}" has mapping(uint32 => ...) but no enumerable domain support detected. Inherit EnumerableDomainSet or use EnumerableMapExtended.`,
      );
    }
  }
}

module.exports = [
  NoVirtualOverrideAllowed,
  NoVirtualInitializerAllowed,
  EnumerableDomainMapping,
];
