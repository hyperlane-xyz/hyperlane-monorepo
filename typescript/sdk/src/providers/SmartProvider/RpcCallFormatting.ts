import { ProviderMethod } from './ProviderMethods.js';

/**
 * Known function selectors for common contract methods.
 * This helps identify what contract method was being called when we only have the call data.
 */
const KNOWN_FUNCTION_SELECTORS: Record<string, string> = {
  // ERC20
  '0x70a08231': 'balanceOf(address)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0xdd62ed3e': 'allowance(address,address)',
  '0x18160ddd': 'totalSupply()',
  '0x313ce567': 'decimals()',
  '0x95d89b41': 'symbol()',
  '0x06fdde03': 'name()',
  // Ownable
  '0x8da5cb5b': 'owner()',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  // Hyperlane Mailbox
  '0xe495f1d4': 'localDomain()',
  '0x2ad27168': 'dispatch(uint32,bytes32,bytes)',
  '0x7c39d130': 'process(bytes,bytes)',
  '0xf794687b': 'recipientIsm(address)',
  '0x7fc5f8d7': 'defaultIsm()',
  '0x94a40de7': 'requiredHook()',
  '0xd93b8100': 'defaultHook()',
  '0x949d225d': 'count()',
  '0x0f0bc738': 'latestCheckpoint()',
  '0xd5438eae': 'delivered(bytes32)',
  // Hyperlane Router
  '0x567bcc98': 'domains()',
  '0xf65cfc19': 'routers(uint32)',
  '0xdcdc5dd4': 'enrollRemoteRouter(uint32,bytes32)',
  '0xaa856b29': 'enrollRemoteRouters(uint32[],bytes32[])',
  // ISM
  '0xa1d00b05': 'verify(bytes,bytes)',
  '0xb771b3bc': 'moduleType()',
  // Warp Route / Token
  '0x6ccbae5f': 'interchainSecurityModule()',
  '0xbf79ce58': 'transferRemote(uint32,bytes32,uint256)',
  '0x3f4ba83a': 'pause()',
  '0x8456cb59': 'unpause()',
  '0x5c975abb': 'paused()',
  // IGP
  '0x45a54f98': 'quoteGasPayment(uint32,uint256)',
  '0x6f928aa7': 'payForGas(bytes32,uint32,uint256,address)',
  '0x38d52e0f': 'beneficiary()',
  // ProxyAdmin
  '0x204e1c7a': 'getProxyAdmin(address)',
  '0x7eff275e': 'changeProxyAdmin(address,address)',
  '0x3659cfe6': 'upgrade(address,address)',
  '0x9623609d': 'upgradeAndCall(address,address,bytes)',
  // Package version
  '0x04a5e332': 'PACKAGE_VERSION()',
};

/**
 * Extracts the function selector (first 4 bytes) from call data
 */
export function getFunctionSelector(data: string): string | undefined {
  if (!data || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase();
}

/**
 * Attempts to get a human-readable function name from a selector
 */
export function getFunctionNameFromSelector(
  selector: string,
): string | undefined {
  return KNOWN_FUNCTION_SELECTORS[selector.toLowerCase()];
}

/**
 * Truncates a hex string for display purposes
 */
function truncateHex(hex: string, maxLength: number = 20): string {
  if (!hex) return '';
  if (hex.length <= maxLength) return hex;
  return `${hex.slice(0, maxLength / 2 + 2)}...${hex.slice(-maxLength / 2)}`;
}

/**
 * Formats call transaction params into a human-readable string
 */
function formatCallParams(transaction: {
  to?: string;
  from?: string;
  data?: string;
  value?: string;
}): string {
  const parts: string[] = [];

  if (transaction.to) {
    parts.push(`to: ${transaction.to}`);
  }

  if (transaction.data) {
    const selector = getFunctionSelector(transaction.data);
    if (selector) {
      const functionName = getFunctionNameFromSelector(selector);
      if (functionName) {
        parts.push(`method: ${functionName}`);
      } else {
        parts.push(`selector: ${selector}`);
      }
      // Include truncated data for debugging
      if (transaction.data.length > 10) {
        parts.push(`calldata: ${truncateHex(transaction.data, 40)}`);
      }
    }
  }

  if (transaction.from) {
    parts.push(`from: ${transaction.from}`);
  }

  if (transaction.value && transaction.value !== '0x0') {
    parts.push(`value: ${transaction.value}`);
  }

  return parts.join(', ');
}

/**
 * Formats getLogs filter params into a human-readable string
 */
function formatLogsParams(filter: {
  address?: string;
  topics?: (string | null)[];
  fromBlock?: string | number;
  toBlock?: string | number;
}): string {
  const parts: string[] = [];

  if (filter.address) {
    parts.push(`address: ${filter.address}`);
  }

  if (filter.topics?.length) {
    const topics = filter.topics.filter(Boolean);
    if (topics.length > 0) {
      parts.push(`topics[0]: ${truncateHex(topics[0] as string, 20)}`);
      if (topics.length > 1) {
        parts.push(`+${topics.length - 1} more topics`);
      }
    }
  }

  if (filter.fromBlock !== undefined) {
    parts.push(`fromBlock: ${filter.fromBlock}`);
  }

  if (filter.toBlock !== undefined) {
    parts.push(`toBlock: ${filter.toBlock}`);
  }

  return parts.join(', ');
}

/**
 * Formats RPC method parameters into a human-readable description.
 * This helps understand what specific operation failed when an RPC call errors.
 */
export function formatRpcParams(
  method: string,
  params: Record<string, any>,
): string {
  try {
    switch (method) {
      case ProviderMethod.Call:
      case ProviderMethod.EstimateGas:
        if (params.transaction) {
          return formatCallParams(params.transaction);
        }
        break;

      case ProviderMethod.GetLogs:
        if (params.filter) {
          return formatLogsParams(params.filter);
        }
        break;

      case ProviderMethod.GetBalance:
        if (params.address) {
          return `address: ${params.address}`;
        }
        break;

      case ProviderMethod.GetCode:
        if (params.address) {
          return `address: ${params.address}`;
        }
        break;

      case ProviderMethod.GetStorageAt:
        if (params.address || params.position) {
          return `address: ${params.address}, position: ${params.position}`;
        }
        break;

      case ProviderMethod.GetTransaction:
      case ProviderMethod.GetTransactionReceipt:
        if (params.transactionHash) {
          return `txHash: ${params.transactionHash}`;
        }
        break;

      case ProviderMethod.GetTransactionCount:
        if (params.address) {
          return `address: ${params.address}`;
        }
        break;

      case ProviderMethod.SendTransaction:
        if (params.signedTransaction) {
          return `signedTx: ${truncateHex(params.signedTransaction, 30)}`;
        }
        break;

      case ProviderMethod.GetBlock:
        if (params.blockTag !== undefined) {
          return `blockTag: ${params.blockTag}`;
        }
        if (params.blockHash !== undefined) {
          return `blockHash: ${params.blockHash}`;
        }
        break;

      case ProviderMethod.GetBlockNumber:
      case ProviderMethod.GetGasPrice:
      case ProviderMethod.MaxPriorityFeePerGas:
        // These methods don't have interesting params
        return '';
    }

    // Fallback: stringify params but limit length
    const paramStr = JSON.stringify(params);
    if (paramStr.length > 200) {
      return paramStr.slice(0, 200) + '...';
    }
    return paramStr;
  } catch {
    return '';
  }
}

/**
 * Formats a complete RPC call description for logging
 */
export function formatRpcCall(
  method: string,
  params: Record<string, any>,
): string {
  const formattedParams = formatRpcParams(method, params);
  if (formattedParams) {
    return `${method}(${formattedParams})`;
  }
  return method;
}

/**
 * Error context extracted from ethers.js errors
 */
export interface EthersErrorContext {
  code?: string;
  reason?: string;
  method?: string;
  transaction?: {
    to?: string;
    from?: string;
    data?: string;
  };
  error?: {
    message?: string;
    code?: number;
    data?: string;
  };
}

/**
 * Extracts relevant error context from an ethers.js error object.
 * Ethers errors often contain rich debugging information that we want to preserve.
 */
export function extractEthersErrorContext(error: any): EthersErrorContext {
  const context: EthersErrorContext = {};

  if (!error || typeof error !== 'object') {
    return context;
  }

  // Standard ethers error properties
  if (error.code) context.code = error.code;
  if (error.reason) context.reason = error.reason;
  if (error.method) context.method = error.method;

  // Transaction context (for CALL_EXCEPTION etc)
  if (error.transaction) {
    context.transaction = {
      to: error.transaction.to,
      from: error.transaction.from,
      data: error.transaction.data,
    };
  }

  // Nested error info (common in RPC responses)
  if (error.error && typeof error.error === 'object') {
    context.error = {
      message: error.error.message,
      code: error.error.code,
      data: error.error.data,
    };
  }

  return context;
}

/**
 * Formats an ethers error context into a human-readable string
 */
export function formatEthersErrorContext(context: EthersErrorContext): string {
  const parts: string[] = [];

  if (context.code) {
    parts.push(`code: ${context.code}`);
  }

  if (context.reason) {
    parts.push(`reason: ${context.reason}`);
  }

  if (context.method) {
    parts.push(`contractMethod: ${context.method}`);
  }

  if (context.transaction) {
    const txParts: string[] = [];
    if (context.transaction.to) txParts.push(`to: ${context.transaction.to}`);
    if (context.transaction.data) {
      const selector = getFunctionSelector(context.transaction.data);
      if (selector) {
        const functionName = getFunctionNameFromSelector(selector);
        if (functionName) {
          txParts.push(`function: ${functionName}`);
        } else {
          txParts.push(`selector: ${selector}`);
        }
      }
    }
    if (txParts.length > 0) {
      parts.push(`tx: {${txParts.join(', ')}}`);
    }
  }

  if (context.error?.message) {
    parts.push(`rpcError: ${context.error.message}`);
  }

  return parts.join(', ');
}

/**
 * Creates an enhanced error message that includes both the original error
 * and the RPC call context
 */
export function createEnhancedErrorMessage(
  error: any,
  method: string,
  params: Record<string, any>,
  chainName: string,
): string {
  const parts: string[] = [];

  // Basic error info
  const reason = error?.reason || error?.message || 'Unknown error';
  parts.push(reason);

  // Add RPC call context
  const callContext = formatRpcCall(method, params);
  if (callContext !== method) {
    parts.push(`RPC call: ${callContext}`);
  } else {
    parts.push(`RPC method: ${method}`);
  }

  // Add chain info
  parts.push(`chain: ${chainName}`);

  // Add ethers error context if available
  const ethersContext = extractEthersErrorContext(error);
  const formattedContext = formatEthersErrorContext(ethersContext);
  if (
    formattedContext &&
    !parts.some((p) => p.includes(ethersContext.reason || ''))
  ) {
    parts.push(formattedContext);
  }

  return parts.join(' | ');
}
