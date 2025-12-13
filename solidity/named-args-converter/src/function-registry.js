/**
 * FunctionRegistry - Collects and indexes all function definitions from Solidity files
 *
 * This module handles:
 * - Contract/library/interface function definitions
 * - Function overloading (multiple functions with same name but different parameters)
 * - Constructor definitions
 * - Event definitions
 * - Custom error definitions
 * - Modifier definitions
 */
import parser from '@solidity-parser/parser';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';

/**
 * Creates a signature key for a function based on name and parameter count/types
 */
function createSignatureKey(name, params) {
  if (!params || params.length === 0) return `${name}()`;

  const paramTypes = params
    .map((p) => {
      if (!p.typeName) return 'unknown';
      return getTypeName(p.typeName);
    })
    .join(',');

  return `${name}(${paramTypes})`;
}

/**
 * Gets the type name from a TypeName AST node
 */
function getTypeName(typeName) {
  if (!typeName) return 'unknown';

  switch (typeName.type) {
    case 'ElementaryTypeName':
      return typeName.name;
    case 'UserDefinedTypeName':
      return typeName.namePath;
    case 'ArrayTypeName':
      return `${getTypeName(typeName.baseTypeName)}[]`;
    case 'Mapping':
      return `mapping(${getTypeName(typeName.keyType)}=>${getTypeName(typeName.valueType)})`;
    case 'FunctionTypeName':
      return 'function';
    default:
      return 'unknown';
  }
}

/**
 * FunctionRegistry class for collecting and looking up function definitions
 */
export class FunctionRegistry {
  constructor() {
    // Map of contractName -> Map of functionName -> Array of {params, signature}
    this.contracts = new Map();
    // Map of functionName -> Array of {params, signature, contractName}
    this.globalFunctions = new Map();
    // Map of eventName -> Array of {params}
    this.events = new Map();
    // Map of errorName -> Array of {params}
    this.errors = new Map();
    // Map of modifierName -> Array of {params}
    this.modifiers = new Map();
    // Contract inheritance relationships
    this.inheritance = new Map();
    // Import mappings
    this.imports = new Map();
    // Parsed files cache
    this.parsedFiles = new Map();
    // Using-for declarations: type -> library functions
    this.usingFor = new Map();
    // Map of contractName -> Map of varName -> typeName (state variables)
    this.stateVariables = new Map();
  }

  /**
   * Parse a single Solidity file and register all functions
   */
  parseFile(filePath, source = null) {
    try {
      if (!source) {
        source = fs.readFileSync(filePath, 'utf8');
      }

      const ast = parser.parse(source, {
        loc: true,
        range: true,
        tolerant: true,
      });

      this.parsedFiles.set(filePath, { source, ast });
      this._processAST(ast, filePath);

      return ast;
    } catch (error) {
      console.error(`Error parsing ${filePath}:`, error.message);
      return null;
    }
  }

  /**
   * Parse all Solidity files in a directory
   */
  async parseDirectory(directory, pattern = '**/*.sol') {
    const files = await glob(pattern, { cwd: directory, absolute: true });

    for (const file of files) {
      this.parseFile(file);
    }

    return files.length;
  }

  /**
   * Parse Foundry build artifacts from out/ directory
   * This extracts function definitions from compiled ABIs
   */
  async parseFoundryArtifacts(outDirectory) {
    const artifactFiles = await glob('**/*.json', {
      cwd: outDirectory,
      absolute: true,
    });

    let contractCount = 0;
    for (const file of artifactFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const artifact = JSON.parse(content);

        if (!artifact.abi || !Array.isArray(artifact.abi)) {
          continue;
        }

        // Extract contract name from file path (e.g., out/IOutbox.sol/IOutbox.json -> IOutbox)
        const contractName = path.basename(file, '.json');

        this._registerArtifactABI(contractName, artifact.abi);
        contractCount++;
      } catch (error) {
        // Skip files that can't be parsed
      }
    }

    return contractCount;
  }

  /**
   * Register functions and events from an ABI
   */
  _registerArtifactABI(contractName, abi) {
    if (!this.contracts.has(contractName)) {
      this.contracts.set(contractName, new Map());
    }

    for (const item of abi) {
      if (item.type === 'function') {
        this._registerArtifactFunction(contractName, item);
      } else if (item.type === 'event') {
        this._registerArtifactEvent(contractName, item);
      }
    }
  }

  /**
   * Register a function from an ABI item
   */
  _registerArtifactFunction(contractName, funcItem) {
    const funcName = funcItem.name;
    if (!funcName) return;

    const params = (funcItem.inputs || []).map((input) => ({
      name: input.name,
      type: input.type,
    }));

    // Skip if any parameter is unnamed
    if (params.some((p) => !p.name)) return;

    const signature = `${funcName}(${params.map((p) => p.type).join(',')})`;

    const contractFuncs = this.contracts.get(contractName);
    if (!contractFuncs.has(funcName)) {
      contractFuncs.set(funcName, []);
    }

    // Check if this exact signature already exists
    const existing = contractFuncs.get(funcName);
    if (!existing.some((f) => f.signature === signature)) {
      existing.push({
        params,
        signature,
        fromArtifact: true,
      });

      // Also add to global functions
      if (!this.globalFunctions.has(funcName)) {
        this.globalFunctions.set(funcName, []);
      }
      this.globalFunctions.get(funcName).push({
        params,
        signature,
        contractName,
        fromArtifact: true,
      });
    }
  }

  /**
   * Register an event from an ABI item
   */
  _registerArtifactEvent(contractName, eventItem) {
    const eventName = eventItem.name;
    if (!eventName) return;

    const params = (eventItem.inputs || []).map((input) => ({
      name: input.name,
      type: input.type,
    }));

    // Skip if any parameter is unnamed
    if (params.some((p) => !p.name)) return;

    if (!this.events.has(eventName)) {
      this.events.set(eventName, []);
    }

    // Check if this event already exists with same param count
    const existing = this.events.get(eventName);
    if (!existing.some((e) => e.params.length === params.length)) {
      existing.push({
        params,
        contractName,
        fromArtifact: true,
      });
    }
  }

  /**
   * Process the AST and register all functions
   */
  _processAST(ast, filePath) {
    if (!ast || !ast.children) return;

    for (const node of ast.children) {
      switch (node.type) {
        case 'ContractDefinition':
          this._processContract(node, filePath);
          break;
        case 'ImportDirective':
          this._processImport(node, filePath);
          break;
      }
    }
  }

  /**
   * Process a contract definition
   */
  _processContract(contract, filePath) {
    const contractName = contract.name;

    if (!this.contracts.has(contractName)) {
      this.contracts.set(contractName, new Map());
    }

    if (!this.stateVariables.has(contractName)) {
      this.stateVariables.set(contractName, new Map());
    }

    // Record inheritance
    if (contract.baseContracts && contract.baseContracts.length > 0) {
      const baseNames = contract.baseContracts.map(
        (bc) => bc.baseName.namePath,
      );
      this.inheritance.set(contractName, baseNames);
    }

    // Process sub-nodes
    for (const node of contract.subNodes || []) {
      switch (node.type) {
        case 'FunctionDefinition':
          this._registerFunction(contractName, node);
          break;
        case 'EventDefinition':
          this._registerEvent(contractName, node);
          break;
        case 'CustomErrorDefinition':
          this._registerError(contractName, node);
          break;
        case 'ModifierDefinition':
          this._registerModifier(contractName, node);
          break;
        case 'UsingForDeclaration':
          this._processUsingFor(contractName, node);
          break;
        case 'StateVariableDeclaration':
          this._registerStateVariables(contractName, node);
          break;
      }
    }
  }

  /**
   * Register state variables for a contract
   */
  _registerStateVariables(contractName, stateVarDecl) {
    const contractVars = this.stateVariables.get(contractName);
    if (!contractVars) return;

    for (const variable of stateVarDecl.variables || []) {
      if (variable.name && variable.typeName) {
        const typeName = getTypeName(variable.typeName);
        if (typeName) {
          contractVars.set(variable.name, typeName);
        }
      }
    }
  }

  /**
   * Get all state variables for a contract, including inherited ones
   */
  getStateVariables(contractName) {
    const result = new Map();

    // First add inherited variables (so they can be overridden by child)
    const bases = this.inheritance.get(contractName);
    if (bases) {
      for (const base of bases) {
        const baseVars = this.getStateVariables(base);
        for (const [name, type] of baseVars) {
          result.set(name, type);
        }
      }
    }

    // Then add this contract's variables
    const contractVars = this.stateVariables.get(contractName);
    if (contractVars) {
      for (const [name, type] of contractVars) {
        result.set(name, type);
      }
    }

    return result;
  }

  /**
   * Register a function definition
   */
  _registerFunction(contractName, funcDef) {
    const funcName =
      funcDef.name || (funcDef.isConstructor ? 'constructor' : null);
    if (!funcName) return;

    const params = funcDef.parameters || [];
    const paramInfo = params.map((p) => ({
      name: p.name,
      type: getTypeName(p.typeName),
      typeName: p.typeName,
    }));

    const signature = createSignatureKey(funcName, params);

    const contractFuncs = this.contracts.get(contractName);
    if (!contractFuncs.has(funcName)) {
      contractFuncs.set(funcName, []);
    }

    // Check for duplicate signature to avoid marking as ambiguous
    const existingFuncs = contractFuncs.get(funcName);
    const alreadyExists = existingFuncs.some((f) => f.signature === signature);
    if (alreadyExists) {
      return; // Skip duplicate
    }

    existingFuncs.push({
      params: paramInfo,
      signature,
      isConstructor: funcDef.isConstructor,
      visibility: funcDef.visibility,
      loc: funcDef.loc,
      range: funcDef.range,
    });

    // Also add to global functions for fallback lookup
    if (!this.globalFunctions.has(funcName)) {
      this.globalFunctions.set(funcName, []);
    }
    this.globalFunctions.get(funcName).push({
      params: paramInfo,
      signature,
      contractName,
    });
  }

  /**
   * Register an event definition
   */
  _registerEvent(contractName, eventDef) {
    const eventName = eventDef.name;
    const params = eventDef.parameters || [];
    const paramInfo = params.map((p) => ({
      name: p.name,
      type: getTypeName(p.typeName),
    }));

    if (!this.events.has(eventName)) {
      this.events.set(eventName, []);
    }
    this.events.get(eventName).push({
      params: paramInfo,
      contractName,
    });
  }

  /**
   * Register a custom error definition
   */
  _registerError(contractName, errorDef) {
    const errorName = errorDef.name;
    const params = errorDef.parameters || [];
    const paramInfo = params.map((p) => ({
      name: p.name,
      type: getTypeName(p.typeName),
    }));

    if (!this.errors.has(errorName)) {
      this.errors.set(errorName, []);
    }
    this.errors.get(errorName).push({
      params: paramInfo,
      contractName,
    });
  }

  /**
   * Register a modifier definition
   */
  _registerModifier(contractName, modDef) {
    const modName = modDef.name;
    const params = modDef.parameters || [];
    const paramInfo = params.map((p) => ({
      name: p.name,
      type: getTypeName(p.typeName),
    }));

    if (!this.modifiers.has(modName)) {
      this.modifiers.set(modName, []);
    }
    this.modifiers.get(modName).push({
      params: paramInfo,
      contractName,
    });
  }

  /**
   * Process using-for declarations
   */
  _processUsingFor(contractName, usingFor) {
    const libraryName = usingFor.libraryName;
    const typeName = usingFor.typeName ? getTypeName(usingFor.typeName) : '*';

    if (!this.usingFor.has(contractName)) {
      this.usingFor.set(contractName, new Map());
    }

    const contractUsing = this.usingFor.get(contractName);
    if (!contractUsing.has(typeName)) {
      contractUsing.set(typeName, []);
    }
    contractUsing.get(typeName).push(libraryName);
  }

  /**
   * Process import directive
   */
  _processImport(importNode, filePath) {
    const importPath = importNode.path;
    const dirPath = path.dirname(filePath);

    // Record symbol aliases
    if (importNode.symbolAliases) {
      for (const [symbol, alias] of importNode.symbolAliases) {
        this.imports.set(alias || symbol, { symbol, importPath, filePath });
      }
    }

    if (importNode.unitAlias) {
      this.imports.set(importNode.unitAlias, { importPath, filePath });
    }
  }

  /**
   * Look up a function by name and argument count within a contract context
   * @param {string} funcName - Function name to look up
   * @param {number} argCount - Number of arguments
   * @param {string|null} contractContext - Contract name to search in
   * @param {boolean} allowGlobalFallback - Whether to fall back to global search (default: true)
   * @param {Array<string|null>} argTypes - Inferred argument types for disambiguation
   */
  lookupFunction(
    funcName,
    argCount,
    contractContext = null,
    allowGlobalFallback = true,
    argTypes = null,
  ) {
    // Check if it's a built-in that shouldn't be converted
    if (this._isBuiltInSkip(funcName)) {
      return null;
    }

    // Try to find in specific contract
    if (contractContext) {
      const result = this._lookupInContract(
        funcName,
        argCount,
        contractContext,
        argTypes,
      );
      if (result) return result;

      // Check inherited contracts
      const bases = this.inheritance.get(contractContext);
      if (bases) {
        for (const base of bases) {
          const result = this._lookupInContract(
            funcName,
            argCount,
            base,
            argTypes,
          );
          if (result) return result;
        }
      }

      // If contract context was provided but not found, don't fall back to global
      // unless explicitly allowed (this prevents mismatched parameter names)
      if (!allowGlobalFallback) {
        return null;
      }
    }

    // Fallback to global search
    const funcs = this.globalFunctions.get(funcName);
    if (!funcs) return null;

    // Find best match by argument count
    const matches = funcs.filter((f) => f.params.length === argCount);
    if (matches.length === 0) {
      return null;
    }

    // Check if all matches have the same parameter names
    const firstParamNames = matches[0].params.map((p) => p.name).join(',');
    const allSameParams = matches.every(
      (m) => m.params.map((p) => p.name).join(',') === firstParamNames,
    );

    if (matches.length === 1 || allSameParams) {
      return matches[0];
    }

    // Multiple matches with different parameter names - try to disambiguate by types
    if (argTypes && argTypes.some((t) => t !== null)) {
      const typeMatch = this._disambiguateByTypes(matches, argTypes);
      if (typeMatch) {
        return typeMatch;
      }
    }

    // Still ambiguous
    return { ...matches[0], ambiguous: true };
  }

  /**
   * Try to disambiguate overloads by matching argument types
   */
  _disambiguateByTypes(matches, argTypes) {
    const scored = matches.map((func) => {
      let score = 0;
      for (let i = 0; i < argTypes.length; i++) {
        const argType = argTypes[i];
        const paramType = func.params[i]?.type;
        if (argType && paramType && this._typesMatch(argType, paramType)) {
          score++;
        }
      }
      return { func, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // If the top score is unique and better than others, return it
    if (scored.length >= 1 && scored[0].score > 0) {
      if (scored.length === 1 || scored[0].score > scored[1].score) {
        return scored[0].func;
      }
    }

    return null;
  }

  /**
   * Check if an inferred argument type matches a parameter type
   */
  _typesMatch(argType, paramType) {
    if (!argType || !paramType) return false;

    // Normalize types for comparison
    const normalizeType = (t) => {
      if (!t) return '';
      // Remove memory/storage/calldata qualifiers for comparison
      // e.g., "bytes memory" -> "bytes", "string calldata" -> "string"
      return t
        .replace(/\s+(memory|storage|calldata)$/i, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    };

    const normArg = normalizeType(argType);
    const normParam = normalizeType(paramType);

    // Direct match
    if (normArg === normParam) return true;

    // Handle uint/int without size (default to 256)
    if (normArg === 'uint' && normParam === 'uint256') return true;
    if (normArg === 'uint256' && normParam === 'uint') return true;
    if (normArg === 'int' && normParam === 'int256') return true;
    if (normArg === 'int256' && normParam === 'int') return true;

    return false;
  }

  /**
   * Look up function in a specific contract
   */
  _lookupInContract(funcName, argCount, contractName, argTypes = null) {
    const contractFuncs = this.contracts.get(contractName);
    if (!contractFuncs) return null;

    const funcs = contractFuncs.get(funcName);
    if (!funcs) return null;

    const matches = funcs.filter((f) => f.params.length === argCount);
    if (matches.length === 1) {
      return matches[0];
    } else if (matches.length > 1) {
      // Try to disambiguate by types
      if (argTypes && argTypes.some((t) => t !== null)) {
        const typeMatch = this._disambiguateByTypes(matches, argTypes);
        if (typeMatch) {
          return typeMatch;
        }
      }
      return { ...matches[0], ambiguous: true };
    }

    return null;
  }

  /**
   * Look up event by name and argument count
   */
  lookupEvent(eventName, argCount) {
    const events = this.events.get(eventName);
    if (!events) return null;

    const matches = events.filter((e) => e.params.length === argCount);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Look up custom error by name and argument count
   */
  lookupError(errorName, argCount) {
    const errors = this.errors.get(errorName);
    if (!errors) return null;

    const matches = errors.filter((e) => e.params.length === argCount);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Check if a function name is a built-in that should be skipped
   */
  _isBuiltInSkip(funcName) {
    const builtIns = new Set([
      // ABI encoding/decoding - these use positional args
      'encode',
      'encodePacked',
      'encodeWithSelector',
      'encodeWithSignature',
      'encodeCall',
      'decode',
      // Type conversions
      'address',
      'uint256',
      'uint128',
      'uint64',
      'uint32',
      'uint16',
      'uint8',
      'int256',
      'int128',
      'int64',
      'int32',
      'int16',
      'int8',
      'bytes32',
      'bytes',
      'string',
      'bool',
      // Special built-ins
      'require',
      'revert',
      'assert',
      'keccak256',
      'sha256',
      'ripemd160',
      'ecrecover',
      'addmod',
      'mulmod',
      'blockhash',
      'selfdestruct',
      // Array operations
      'push',
      'pop',
      // Low level
      'call',
      'delegatecall',
      'staticcall',
    ]);

    return builtIns.has(funcName);
  }

  /**
   * Get statistics about the registry
   */
  getStats() {
    let totalFunctions = 0;
    for (const [_, funcs] of this.contracts) {
      for (const [_, overloads] of funcs) {
        totalFunctions += overloads.length;
      }
    }

    return {
      contracts: this.contracts.size,
      functions: totalFunctions,
      events: this.events.size,
      errors: this.errors.size,
      modifiers: this.modifiers.size,
    };
  }
}

export default FunctionRegistry;
