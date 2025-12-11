/**
 * Solhint Plugin - Named Arguments Rule with Auto-fix
 *
 * This extends the standard func-named-parameters rule with auto-fix capability
 * using the NamedArgsConverter.
 *
 * Usage in .solhintrc:
 * {
 *   "plugins": ["@hyperlane-xyz/named-args-converter"],
 *   "rules": {
 *     "hyperlane/func-named-parameters-fix": ["warn", 4]
 *   }
 * }
 */
import { FunctionRegistry } from './function-registry.js';
import { Transformer } from './transformer.js';

const DEFAULT_MIN_ARGS = 4;

class FuncNamedParametersWithFix {
  constructor(reporter, config, inputSrc) {
    this.ruleId = 'func-named-parameters-fix';
    this.reporter = reporter;
    this.config = config;
    this.inputSrc = inputSrc;

    // Get min args from config
    this.minArgs =
      (config && config.getNumber(this.ruleId, DEFAULT_MIN_ARGS)) ||
      DEFAULT_MIN_ARGS;
    if (this.minArgs < DEFAULT_MIN_ARGS) {
      this.minArgs = DEFAULT_MIN_ARGS;
    }

    // Build function registry from the current file
    this.registry = new FunctionRegistry();

    // Track function calls for fixing
    this.fixableNodes = [];
  }

  // Called when the file starts processing
  enterSourceUnit(ctx) {
    // Parse the source to build function registry
    this.registry.parseFile('current.sol', this.inputSrc);
  }

  FunctionCall(node) {
    const qtyNamed = node.names ? node.names.length : 0;
    const qtyArgs = node.arguments ? node.arguments.length : 0;

    // Skip if already using named args or too few args
    if (qtyNamed > 0 || qtyArgs < this.minArgs) {
      return;
    }

    // Skip ABI calls
    if (this._isAbiCall(node)) {
      return;
    }

    // Skip built-in functions
    if (this._isBuiltIn(node)) {
      return;
    }

    // Try to find fix
    const funcName = this._getFunctionName(node.expression);
    if (!funcName) return;

    const funcDef = this.registry.lookupFunction(funcName, qtyArgs, null);

    if (funcDef && !funcDef.ambiguous) {
      const paramNames = funcDef.params.map((p) => p.name);
      if (paramNames.every((n) => n)) {
        // We can provide a fix
        this.reporter.error(
          node,
          this.ruleId,
          `Function call with ${qtyArgs} unnamed arguments. Consider using named parameters.`,
          this._createFix(node, paramNames),
        );
        return;
      }
    }

    // No fix available, just report
    this.reporter.error(
      node,
      this.ruleId,
      `Function call with ${qtyArgs} unnamed arguments. Named parameters recommended but auto-fix unavailable.`,
    );
  }

  _isAbiCall(node) {
    if (node.expression && node.expression.type === 'MemberAccess') {
      const base = node.expression.expression;
      if (base && base.type === 'Identifier' && base.name === 'abi') {
        return true;
      }
    }
    return false;
  }

  _isBuiltIn(node) {
    const funcName = this._getFunctionName(node.expression);
    const builtIns = new Set([
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
    ]);
    return builtIns.has(funcName);
  }

  _getFunctionName(expression) {
    if (!expression) return null;
    switch (expression.type) {
      case 'Identifier':
        return expression.name;
      case 'MemberAccess':
        return expression.memberName;
      default:
        return null;
    }
  }

  _createFix(node, paramNames) {
    if (!node.range) return null;

    // Build the named arguments replacement
    const argTexts = node.arguments.map((arg, i) => {
      if (!arg.range) return null;
      const argText = this.inputSrc.substring(arg.range[0], arg.range[1] + 1);
      return `${paramNames[i]}: ${argText}`;
    });

    if (argTexts.some((t) => t === null)) return null;

    // Find the opening parenthesis
    const callStart = node.range[0];
    const callEnd = node.range[1];
    const originalText = this.inputSrc.substring(callStart, callEnd + 1);
    const parenIndex = originalText.indexOf('(');

    if (parenIndex === -1) return null;

    const funcExprEnd = callStart + parenIndex;
    const funcExpr = this.inputSrc.substring(callStart, funcExprEnd);

    const replacement = `${funcExpr}({${argTexts.join(', ')}})`;

    return {
      range: [callStart, callEnd + 1],
      text: replacement,
    };
  }
}

// Export for solhint plugin
export default [FuncNamedParametersWithFix];
export { FuncNamedParametersWithFix };
