/**
 * Transformer - Converts Solidity function calls to named arguments syntax
 *
 * This module handles the actual transformation of function calls from:
 *   functionName(arg1, arg2, arg3)
 * to:
 *   functionName({param1: arg1, param2: arg2, param3: arg3})
 */
import parser from '@solidity-parser/parser';

/**
 * Get the function name from a function call expression
 */
function getFunctionName(expression) {
  if (!expression) return null;

  // Unwrap NameValueExpression (e.g., dispatch{value: x}(...))
  if (expression.type === 'NameValueExpression') {
    return getFunctionName(expression.expression);
  }

  switch (expression.type) {
    case 'Identifier':
      return expression.name;
    case 'MemberAccess':
      return expression.memberName;
    case 'NewExpression':
      // Constructor call: new ContractName(...)
      if (
        expression.typeName &&
        expression.typeName.type === 'UserDefinedTypeName'
      ) {
        return 'constructor';
      }
      return null;
    default:
      return null;
  }
}

/**
 * Get the contract context from a member access expression
 */
function getContractContext(expression) {
  if (!expression) return null;

  // Unwrap NameValueExpression (e.g., dispatch{value: x}(...))
  if (expression.type === 'NameValueExpression') {
    return getContractContext(expression.expression);
  }

  if (expression.type === 'MemberAccess') {
    const base = expression.expression;
    if (base.type === 'Identifier') {
      return base.name;
    }
  }

  if (expression.type === 'NewExpression') {
    // Constructor call: new ContractName(...)
    if (
      expression.typeName &&
      expression.typeName.type === 'UserDefinedTypeName'
    ) {
      return expression.typeName.namePath;
    }
  }

  return null;
}

/**
 * Check if a function call should be skipped
 */
function shouldSkipCall(node, funcName) {
  // Skip if already using named arguments
  if (node.names && node.names.length > 0) {
    return true;
  }

  // Skip calls with no arguments
  if (!node.arguments || node.arguments.length === 0) {
    return true;
  }

  // Note: Calls with {value: ...} or {gas: ...} options CAN be converted
  // The value/gas syntax is separate from the function arguments

  // Skip ABI calls
  if (node.expression && node.expression.type === 'MemberAccess') {
    const base = node.expression.expression;
    if (base && base.type === 'Identifier' && base.name === 'abi') {
      return true;
    }
  }

  // Skip type conversions (e.g., address(x), uint256(y))
  if (node.expression && node.expression.type === 'ElementaryTypeName') {
    return true;
  }

  // Skip type casting to user-defined types (e.g., IContract(address))
  if (node.expression && node.expression.type === 'Identifier') {
    // Heuristic: if the name starts with uppercase, it might be a type cast
    const firstChar = funcName?.charAt(0);
    if (
      firstChar &&
      firstChar === firstChar.toUpperCase() &&
      node.arguments.length === 1
    ) {
      // This could be a type conversion, but we need context to be sure
      // For now, we'll skip single-argument calls to identifiers starting with uppercase
      // This might miss some valid conversions, but it's safer
    }
  }

  // Built-in global functions that should not use named arguments
  // Note: These only apply to non-member-access calls
  const globalBuiltIns = new Set([
    'require',
    'revert',
    'assert',
    'keccak256',
    'sha256',
    'sha3',
    'ripemd160',
    'ecrecover',
    'addmod',
    'mulmod',
    'blockhash',
    'selfdestruct',
    'suicide',
    'gasleft',
  ]);

  // Check for direct calls to global built-ins
  if (node.expression && node.expression.type === 'Identifier') {
    if (globalBuiltIns.has(funcName)) {
      return true;
    }
  }

  // Built-in member functions (on elementary types like address, arrays, etc.)
  // Only skip these if called on elementary types, not user-defined types
  const memberBuiltIns = new Set([
    'push',
    'pop',
    'concat',
    'call',
    'delegatecall',
    'staticcall',
    'send',
    'transfer',
  ]);

  if (node.expression && node.expression.type === 'MemberAccess') {
    const base = node.expression.expression;

    // Check if calling on an elementary type or type conversion
    // e.g., address(x).transfer(...), payable(x).send(...)
    if (base.type === 'FunctionCall' && base.expression) {
      // Likely a type conversion like address(...), payable(...)
      if (base.expression.type === 'ElementaryTypeName') {
        if (memberBuiltIns.has(funcName)) {
          return true;
        }
      }
    }

    // Check for direct member access on msg, block, tx
    if (base.type === 'Identifier') {
      if (['msg', 'block', 'tx'].includes(base.name)) {
        return true;
      }
    }

    // For arrays (identified by IndexAccess), skip push/pop
    if (base.type === 'IndexAccess') {
      if (['push', 'pop'].includes(funcName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Transformer class for converting function calls to named arguments
 */
export class Transformer {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.options = {
      minArgs: options.minArgs || 1, // Minimum args to require named params
      dryRun: options.dryRun || false,
      verbose: options.verbose || false,
      ...options,
    };
    this.changes = [];
  }

  /**
   * Transform a Solidity source file
   */
  transform(source, filePath = null) {
    // Parse the source
    let ast;
    try {
      ast = parser.parse(source, {
        loc: true,
        range: true,
        tolerant: true,
      });
    } catch (error) {
      console.error(`Parse error in ${filePath || 'source'}:`, error.message);
      return { source, changes: [], errors: [error.message] };
    }

    // Collect all function calls that need transformation
    this.changes = [];
    this._collectCalls(ast, source, filePath);

    // Apply transformations in reverse order (to preserve positions)
    if (!this.options.dryRun && this.changes.length > 0) {
      source = this._applyChanges(source);
    }

    return {
      source,
      changes: this.changes,
      errors: [],
    };
  }

  /**
   * Collect all function calls that need transformation
   */
  _collectCalls(ast, source, filePath) {
    const self = this;
    let currentContract = null;

    // Track variable types within contracts for resolving member access
    this.variableTypes = new Map();

    parser.visit(ast, {
      ContractDefinition(node) {
        currentContract = node.name;
        // Initialize with inherited state variables from registry
        self.variableTypes = new Map(
          self.registry.getStateVariables(node.name),
        );
      },
      'ContractDefinition:exit'() {
        currentContract = null;
        self.variableTypes = new Map();
      },
      StateVariableDeclaration(node) {
        // Track state variable types (e.g., IExternal ext;)
        // These are also in the registry but we track locally for completeness
        if (node.variables) {
          for (const variable of node.variables) {
            if (variable.name && variable.typeName) {
              const typeName = self._getTypeName(variable.typeName);
              if (typeName) {
                self.variableTypes.set(variable.name, typeName);
              }
            }
          }
        }
      },
      VariableDeclarationStatement(node) {
        // Track local variable declarations
        if (node.variables) {
          for (const variable of node.variables) {
            if (variable && variable.name && variable.typeName) {
              const typeName = self._getTypeName(variable.typeName);
              if (typeName) {
                self.variableTypes.set(variable.name, typeName);
              }
            }
          }
        }
      },
      FunctionDefinition(node) {
        // Track function parameter types
        if (node.parameters) {
          for (const param of node.parameters) {
            if (param.name && param.typeName) {
              const typeName = self._getTypeName(param.typeName);
              if (typeName) {
                self.variableTypes.set(param.name, typeName);
              }
            }
          }
        }
      },
      FunctionCall(node) {
        self._processFunctionCall(node, source, currentContract);
      },
    });
  }

  /**
   * Get the type name from a TypeName AST node
   */
  _getTypeName(typeName) {
    if (!typeName) return null;

    switch (typeName.type) {
      case 'ElementaryTypeName':
        return typeName.name;
      case 'UserDefinedTypeName':
        return typeName.namePath;
      case 'ArrayTypeName':
        return this._getTypeName(typeName.baseTypeName) + '[]';
      default:
        return null;
    }
  }

  /**
   * Infer the type of an expression AST node
   * Returns null if type cannot be determined
   */
  _inferExpressionType(expr) {
    if (!expr) return null;

    switch (expr.type) {
      case 'Identifier':
        // Look up variable type
        return this.variableTypes?.get(expr.name) || null;

      case 'NumberLiteral':
        // Could be uint or int, default to uint256
        return 'uint256';

      case 'BooleanLiteral':
        return 'bool';

      case 'StringLiteral':
        return 'string';

      case 'HexLiteral':
        return 'bytes';

      case 'TupleExpression':
        // For single-element tuples, unwrap
        if (expr.components?.length === 1) {
          return this._inferExpressionType(expr.components[0]);
        }
        return null;

      case 'MemberAccess':
        // For now, don't try to infer member access types
        return null;

      case 'IndexAccess':
        // Array access - would need element type inference
        return null;

      case 'FunctionCall':
        // Type conversion: address(x), bytes32(x), etc.
        if (expr.expression?.type === 'ElementaryTypeName') {
          return expr.expression.name;
        }
        // User-defined type conversion: IFoo(x)
        if (expr.expression?.type === 'Identifier') {
          // Could be a type cast, return the type name
          const name = expr.expression.name;
          // Check if it looks like a type (starts with uppercase or is a known interface)
          if (name[0] === name[0].toUpperCase()) {
            return name;
          }
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Infer types for all arguments in a function call
   */
  _inferArgumentTypes(args) {
    return args.map((arg) => this._inferExpressionType(arg));
  }

  /**
   * Process a single function call
   */
  _processFunctionCall(node, source, currentContract) {
    const funcName = getFunctionName(node.expression);

    // Skip if no function name or should be skipped
    if (!funcName || shouldSkipCall(node, funcName)) {
      return;
    }

    // Skip if fewer args than minimum
    if (node.arguments.length < this.options.minArgs) {
      return;
    }

    // Unwrap NameValueExpression to get the actual expression
    // (e.g., dispatch{value: x}(...) -> dispatch)
    let actualExpression = node.expression;
    if (actualExpression.type === 'NameValueExpression') {
      actualExpression = actualExpression.expression;
    }

    // Determine if this is a member access call (e.g., foo.bar(...))
    const isMemberAccess = actualExpression.type === 'MemberAccess';

    // Infer argument types for overload disambiguation
    const argTypes = this._inferArgumentTypes(node.arguments);

    // Try to find the function definition
    let contractContext = getContractContext(node.expression);
    let funcDef = null;
    let resolvedFromType = false;

    // For member access calls, try to resolve the type
    if (isMemberAccess) {
      const baseExpr = actualExpression.expression;

      // Case 1: Simple identifier (e.g., mailbox.dispatch(...))
      if (baseExpr?.type === 'Identifier') {
        const varName = baseExpr.name;
        if (this.variableTypes && this.variableTypes.has(varName)) {
          contractContext = this.variableTypes.get(varName);
          resolvedFromType = true;
        }
      }

      // Case 2: Type cast (e.g., IContract(address).method(...))
      if (baseExpr?.type === 'FunctionCall' && baseExpr.expression) {
        // Check if it's a type cast to a user-defined type
        if (baseExpr.expression.type === 'Identifier') {
          const typeName = baseExpr.expression.name;
          // If it starts with uppercase, it's likely a type cast
          if (typeName && typeName[0] === typeName[0].toUpperCase()) {
            contractContext = typeName;
            resolvedFromType = true;
          }
        }
      }
    }

    // Try specific contract first
    // For member access calls, don't allow global fallback to prevent wrong param names
    if (contractContext) {
      funcDef = this.registry.lookupFunction(
        funcName,
        node.arguments.length,
        contractContext,
        !isMemberAccess, // allowGlobalFallback: false for member access
        argTypes,
      );
    }

    // For member access calls, if we couldn't resolve the type, skip conversion
    // This prevents mismatched parameter names from external libraries
    if (isMemberAccess && !funcDef) {
      if (this.options.verbose) {
        console.log(
          `Skipping member access call ${funcName}() - couldn't resolve type`,
        );
      }
      return;
    }

    // Fallback to current contract context (only for non-member-access calls)
    if (!funcDef && currentContract) {
      funcDef = this.registry.lookupFunction(
        funcName,
        node.arguments.length,
        currentContract,
        true,
        argTypes,
      );
    }

    // Global fallback (only for non-member-access calls)
    if (!funcDef) {
      funcDef = this.registry.lookupFunction(
        funcName,
        node.arguments.length,
        null,
        true,
        argTypes,
      );
    }

    // Also check events and errors (for emit and revert statements)
    const eventDef = this.registry.lookupEvent(funcName, node.arguments.length);
    const errorDef = this.registry.lookupError(funcName, node.arguments.length);

    const definition = funcDef || eventDef || errorDef;

    if (!definition) {
      if (this.options.verbose) {
        console.log(
          `No definition found for ${funcName}(${node.arguments.length} args) in context ${contractContext || currentContract || 'global'}`,
        );
      }
      return;
    }

    // Skip if ambiguous (multiple overloads match)
    if (definition.ambiguous) {
      if (this.options.verbose) {
        console.log(`Ambiguous function ${funcName} - skipping`);
      }
      return;
    }

    // Get parameter names
    const paramNames = definition.params.map((p) => p.name);

    // Skip if any parameter name is missing
    if (paramNames.some((n) => !n)) {
      if (this.options.verbose) {
        console.log(`Function ${funcName} has unnamed parameters - skipping`);
      }
      return;
    }

    // Skip if number of args doesn't match parameters
    if (node.arguments.length !== paramNames.length) {
      return;
    }

    // Create the transformation
    this._createChange(node, source, funcName, paramNames);
  }

  /**
   * Create a change record for a function call
   */
  _createChange(node, source, funcName, paramNames) {
    if (!node.range) return;

    const callStart = node.range[0];
    const callEnd = node.range[1];

    // Get the original call text
    const originalText = source.substring(callStart, callEnd + 1);

    // For member access calls like `foo().bar(args)`, we need to find the opening
    // parenthesis for THIS call's arguments, not a nested call's parenthesis.
    // Use the first argument's position to find the correct opening paren.
    let parenIndex;
    if (node.arguments.length > 0 && node.arguments[0].range) {
      // Find the '(' that comes just before the first argument
      const firstArgStart = node.arguments[0].range[0];
      const textBeforeFirstArg = source.substring(callStart, firstArgStart);
      parenIndex = textBeforeFirstArg.lastIndexOf('(');
    } else {
      // Fallback for no-argument calls (shouldn't happen given our filters)
      parenIndex = originalText.indexOf('(');
    }
    if (parenIndex === -1) return;

    // Get the function expression part
    const funcExprEnd = callStart + parenIndex;
    const funcExpr = source.substring(callStart, funcExprEnd);

    // Build the named arguments
    const argTexts = node.arguments.map((arg, i) => {
      if (!arg.range) return null;
      const argText = source.substring(arg.range[0], arg.range[1] + 1);
      return `${paramNames[i]}: ${argText}`;
    });

    if (argTexts.some((t) => t === null)) return;

    // Determine if we should use single-line or multi-line format
    const totalLength = funcExpr.length + argTexts.join(', ').length + 4;
    const useMultiLine = totalLength > 100 || argTexts.length > 3;

    let newArgsText;
    if (useMultiLine) {
      // Detect indentation from original
      const lineStart = source.lastIndexOf('\n', callStart) + 1;
      const indent =
        source.substring(lineStart, callStart).match(/^\s*/)?.[0] || '';
      const innerIndent = indent + '    ';
      newArgsText = `({\n${innerIndent}${argTexts.join(',\n' + innerIndent)}\n${indent}})`;
    } else {
      newArgsText = `({${argTexts.join(', ')}})`;
    }

    const newText = funcExpr + newArgsText;

    this.changes.push({
      funcName,
      paramNames,
      start: callStart,
      end: callEnd + 1,
      original: originalText,
      replacement: newText,
      loc: node.loc,
    });
  }

  /**
   * Apply all collected changes to the source
   */
  _applyChanges(source) {
    // Filter out nested calls - if a call is contained within another call we're converting,
    // skip it to avoid position corruption after replacement
    const filteredChanges = this._filterNestedCalls(this.changes);

    // Sort changes by start position in reverse order
    const sortedChanges = [...filteredChanges].sort(
      (a, b) => b.start - a.start,
    );

    let result = source;
    for (const change of sortedChanges) {
      result =
        result.substring(0, change.start) +
        change.replacement +
        result.substring(change.end);
    }

    return result;
  }

  /**
   * Filter out overlapping function calls to avoid position corruption
   * When two calls overlap (one contains another, or they share ranges),
   * we can only safely convert non-overlapping calls.
   *
   * Strategy: For overlapping calls, keep the innermost (smallest range) one,
   * as it's the most specific and least likely to affect other positions.
   */
  _filterNestedCalls(changes) {
    if (changes.length <= 1) return changes;

    const toRemove = new Set();

    // Check each pair of changes for overlap
    for (let i = 0; i < changes.length; i++) {
      if (toRemove.has(i)) continue;
      const call1 = changes[i];
      const size1 = call1.end - call1.start;

      for (let j = i + 1; j < changes.length; j++) {
        if (toRemove.has(j)) continue;
        const call2 = changes[j];
        const size2 = call2.end - call2.start;

        // Check if ranges overlap
        const overlaps = !(
          call1.end <= call2.start || call2.end <= call1.start
        );

        if (overlaps) {
          // Remove the larger one (keep the more specific/inner call)
          if (size1 >= size2) {
            toRemove.add(i);
          } else {
            toRemove.add(j);
          }
        }
      }
    }

    return changes.filter((_, i) => !toRemove.has(i));
  }

  /**
   * Get a summary of changes
   */
  getSummary() {
    const byFunction = new Map();
    for (const change of this.changes) {
      const count = byFunction.get(change.funcName) || 0;
      byFunction.set(change.funcName, count + 1);
    }

    return {
      totalChanges: this.changes.length,
      byFunction: Object.fromEntries(byFunction),
    };
  }
}

export default Transformer;
