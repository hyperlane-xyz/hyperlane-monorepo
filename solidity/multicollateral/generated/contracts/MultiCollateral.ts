/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type {
  ArtifactEntry,
  ContractMethodMap,
  RunnerLike,
  ViemContractLike,
} from '@hyperlane-xyz/core';
import { ViemContractFactory } from '@hyperlane-xyz/core';

export const MultiCollateralAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "erc20",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_scaleNumerator",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_scaleDenominator",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_mailbox",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "PACKAGE_VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "addBridge",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "bridge",
        "type": "address",
        "internalType": "contract ITokenBridge"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addRebalancer",
    "inputs": [
      {
        "name": "rebalancer",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowance",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedBridges",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedRebalancers",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedRecipient",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "approve",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "approveTokenForBridge",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "bridge",
        "type": "address",
        "internalType": "contract ITokenBridge"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "asset",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "convertToAssets",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "convertToShares",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "decimals",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "decreaseAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "subtractedValue",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "destinationGas",
    "inputs": [
      {
        "name": "destinationDomain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "gasLimit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "domains",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32[]",
        "internalType": "uint32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "donate",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "enrollRemoteRouter",
    "inputs": [
      {
        "name": "_domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_router",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "enrollRemoteRouters",
    "inputs": [
      {
        "name": "_domains",
        "type": "uint32[]",
        "internalType": "uint32[]"
      },
      {
        "name": "_addresses",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "enrollRouters",
    "inputs": [
      {
        "name": "_domains",
        "type": "uint32[]",
        "internalType": "uint32[]"
      },
      {
        "name": "_routers",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "enrolledRouters",
    "inputs": [
      {
        "name": "_domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_router",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeHook",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeRecipient",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeToken",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEnrolledRouters",
    "inputs": [
      {
        "name": "_domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "handle",
    "inputs": [
      {
        "name": "_origin",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_sender",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_message",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "hook",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPostDispatchHook"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "increaseAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "addedValue",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "initialize",
    "inputs": [
      {
        "name": "_hook",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_interchainSecurityModule",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "interchainSecurityModule",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IInterchainSecurityModule"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "localDomain",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mailbox",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMailbox"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxDeposit",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxMint",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxRedeem",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxWithdraw",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mint",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "name",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewDeposit",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewMint",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewRedeem",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewWithdraw",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteGasPayment",
    "inputs": [
      {
        "name": "_destinationDomain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteTransferRemote",
    "inputs": [
      {
        "name": "_destination",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "quotes",
        "type": "tuple[]",
        "internalType": "struct Quote[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteTransferRemoteTo",
    "inputs": [
      {
        "name": "_destination",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_targetRouter",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "quotes",
        "type": "tuple[]",
        "internalType": "struct Quote[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rebalance",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "collateralAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bridge",
        "type": "address",
        "internalType": "contract ITokenBridge"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "redeem",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "removeBridge",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "bridge",
        "type": "address",
        "internalType": "contract ITokenBridge"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "removeRebalancer",
    "inputs": [
      {
        "name": "rebalancer",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "removeRecipient",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "routers",
    "inputs": [
      {
        "name": "_domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "scaleDenominator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "scaleNumerator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setDestinationGas",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "gas",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDestinationGas",
    "inputs": [
      {
        "name": "gasConfigs",
        "type": "tuple[]",
        "internalType": "struct GasRouter.GasRouterConfig[]",
        "components": [
          {
            "name": "domain",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "gas",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeHook",
    "inputs": [
      {
        "name": "_feeHook",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeRecipient",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setHook",
    "inputs": [
      {
        "name": "_hook",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setInterchainSecurityModule",
    "inputs": [
      {
        "name": "_module",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRecipient",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "symbol",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalAssets",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSupply",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transfer",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferFrom",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferRemote",
    "inputs": [
      {
        "name": "_destination",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "messageId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "transferRemoteTo",
    "inputs": [
      {
        "name": "_destination",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_targetRouter",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "messageId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "unenrollRemoteRouter",
    "inputs": [
      {
        "name": "_domain",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "unenrollRemoteRouters",
    "inputs": [
      {
        "name": "_domains",
        "type": "uint32[]",
        "internalType": "uint32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "unenrollRouters",
    "inputs": [
      {
        "name": "_domains",
        "type": "uint32[]",
        "internalType": "uint32[]"
      },
      {
        "name": "_routers",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "wrappedToken",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Approval",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralMoved",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "recipient",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "rebalancer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposit",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "shares",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Donation",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeHookSet",
    "inputs": [
      {
        "name": "feeHook",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeRecipientSet",
    "inputs": [
      {
        "name": "feeRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GasSet",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "gas",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HookSet",
    "inputs": [
      {
        "name": "_hook",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Initialized",
    "inputs": [
      {
        "name": "version",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "IsmSet",
    "inputs": [
      {
        "name": "_ism",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReceivedTransferRemote",
    "inputs": [
      {
        "name": "origin",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "recipient",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "amountOrId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RouterEnrolled",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "router",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RouterUnenrolled",
    "inputs": [
      {
        "name": "domain",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "router",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SentTransferRemote",
    "inputs": [
      {
        "name": "destination",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "recipient",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "amountOrId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Transfer",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdraw",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "receiver",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "shares",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  }
] as const satisfies Abi;

export const MultiCollateralArtifact: ArtifactEntry<typeof MultiCollateralAbi> = {
  contractName: "MultiCollateral",
  abi: MultiCollateralAbi,
  bytecode: "0x6101206040523480156200001257600080fd5b5060405162005a1538038062005a1583398101604081905262000035916200027c565b83838383828282808080806001600160a01b0381163b6200009d5760405162461bcd60e51b815260206004820152601e60248201527f4d61696c626f78436c69656e743a20696e76616c6964206d61696c626f78000060448201526064015b60405180910390fd5b6001600160a01b03821660808190526040805163234d8e3d60e21b81529051638d3638f4916004808201926020929091908290030181865afa158015620000e8573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200010e9190620002c7565b63ffffffff1660a05262000122336200020d565b50505050600083118015620001375750600082115b620001855760405162461bcd60e51b815260206004820152601e60248201527f546f6b656e526f757465723a207363616c652063616e6e6f7420626520300000604482015260640162000094565b5060c09190915260e0526001600160a01b0384163b620001f25760405162461bcd60e51b815260206004820152602160248201527f4879704552433230436f6c6c61746572616c3a20696e76616c696420746f6b656044820152603760f91b606482015260840162000094565b5050506001600160a01b03166101005250620002f692505050565b603380546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b80516001600160a01b03811681146200027757600080fd5b919050565b600080600080608085870312156200029357600080fd5b6200029e856200025f565b93506020850151925060408501519150620002bc606086016200025f565b905092959194509250565b600060208284031215620002da57600080fd5b815163ffffffff81168114620002ef57600080fd5b9392505050565b60805160a05160c05160e0516101005161560f620004066000396000818161068701528181610a7e01528181610e520152818161150e01528181611579015281816115f90152818161177901528181611a4d01528181611ab801528181612d6601528181612f840152818161312401528181613321015281816135ba01528181613620015281816139f00152613e63015260008181610ab201528181612e5a0152613e100152600081816105af01528181612e390152613e31015260008181610970015281816113b3015281816114690152818161209501528181612158015281816122140152613654015260008181610c5b0152818161132e015281816122bb0152613809015261560f6000f3fe60806040526004361061045d5760003560e01c80638da5cb5b1161023f578063c6e6f59211610139578063e9198bf9116100b6578063f2ed8c531161007a578063f2ed8c5314610dc3578063f2fde38b14610de3578063fa57f15714610e03578063fbaca44c14610e23578063fc0c546a14610e4357600080fd5b8063e9198bf914610d5b578063ef8b30f714610c09578063efae508a14610d7b578063f11f446114610d9b578063f14faf6f14610db057600080fd5b8063dd62ed3e116100fd578063dd62ed3e14610cb0578063de523cf314610cd0578063e62e284714610cee578063e74b981b14610d0e578063e83b530014610d2e57600080fd5b8063c6e6f59214610c09578063ce96cb7714610c29578063d5438eae14610c49578063d905777e14610c7d578063d9755d0f14610c9d57600080fd5b8063a9059cbb116101c7578063ba0876521161018b578063ba08765214610b94578063c0c53b8b14610bb4578063c382711514610bd4578063c63d75b6146106ff578063c69c8ce214610bf457600080fd5b8063a9059cbb14610af4578063b1bd643614610b14578063b3d7f6b914610b34578063b460af9414610b54578063b49c53a714610b7457600080fd5b806394bf804d1161020e57806394bf804d14610a3757806395d89b4114610a57578063996c6cc314610a6c5780639f0b765914610aa0578063a457c2d714610ad457600080fd5b80638da5cb5b146109a75780638f16bd4d146109c557806392c18454146109e557806393c4484714610a0557600080fd5b806343bc4b9a1161035b5780636e553f65116102d857806377e2dc7a1161029c57806377e2dc7a146108d85780637f5a7c7b1461090b57806381b4e8b41461092b5780638bd90b821461093e5780638d3638f41461095e57600080fd5b80636e553f651461082057806370a0823114610840578063715018a61461087657806371a15b381461088b578063775313a1146108ab57600080fd5b80634e38a81d1161031f5780634e38a81d1461079857806356d5d475146107b857806360ed438c146107cb578063647846a5146107f85780636a99c3331461080d57600080fd5b806343bc4b9a14610721578063440df4f414610741578063469048401461076357806349d462ef146107785780634cdad506146104a957600080fd5b80631c2eaac0116103e9578063313ce567116103ad578063313ce5671461065157806338d52e0f1461067857806339509351146106bf5780633dfd3873146106df578063402d267d146106ff57600080fd5b80631c2eaac01461059d57806323b872dd146105d15780632a53a6d5146105f15780632c2d8089146106115780632ead72f61461063157600080fd5b80630a28a477116104305780630a28a477146104f95780630c979919146105195780630e72cc061461053b57806318160ddd1461055b5780631ba831491461057057600080fd5b806301e1d1141461046257806306fdde031461048757806307a2d13a146104a9578063095ea7b3146104c9575b600080fd5b34801561046e57600080fd5b50610133545b6040519081526020015b60405180910390f35b34801561049357600080fd5b5061049c610e76565b60405161047e9190614aa4565b3480156104b557600080fd5b506104746104c4366004614ab7565b610f08565b3480156104d557600080fd5b506104e96104e4366004614ae5565b610f1b565b604051901515815260200161047e565b34801561050557600080fd5b50610474610514366004614ab7565b610f33565b34801561052557600080fd5b50610539610534366004614b11565b610f40565b005b34801561054757600080fd5b50610539610556366004614b11565b610f57565b34801561056757600080fd5b5060d154610474565b34801561057c57600080fd5b5061059061058b366004614b42565b610ffa565b60405161047e9190614b5d565b3480156105a957600080fd5b506104747f000000000000000000000000000000000000000000000000000000000000000081565b3480156105dd57600080fd5b506104e96105ec366004614baa565b61101b565b3480156105fd57600080fd5b5061053961060c366004614c30565b611041565b34801561061d57600080fd5b5061053961062c366004614c9c565b611190565b34801561063d57600080fd5b5061047461064c366004614b42565b6111bb565b34801561065d57600080fd5b506106666111da565b60405160ff909116815260200161047e565b34801561068457600080fd5b507f00000000000000000000000000000000000000000000000000000000000000005b6040516001600160a01b03909116815260200161047e565b3480156106cb57600080fd5b506104e96106da366004614ae5565b6111fa565b3480156106eb57600080fd5b506105396106fa366004614b11565b61121c565b34801561070b57600080fd5b5061047461071a366004614b11565b5060001990565b34801561072d57600080fd5b5061053961073c366004614b11565b6112ae565b34801561074d57600080fd5b506107566112c1565b60405161047e9190614cb8565b34801561076f57600080fd5b506106a76112cd565b34801561078457600080fd5b50610539610793366004614c9c565b611300565b3480156107a457600080fd5b506105396107b3366004614cf6565b611312565b6105396107c6366004614d2d565b611324565b3480156107d757600080fd5b506107eb6107e6366004614db4565b611419565b60405161047e9190614ded565b34801561080457600080fd5b506106a76115d7565b61053961081b366004614e45565b61161b565b34801561082c57600080fd5b5061047461083b366004614e85565b6118f3565b34801561084c57600080fd5b5061047461085b366004614b11565b6001600160a01b0316600090815260cf602052604090205490565b34801561088257600080fd5b5061053961190d565b34801561089757600080fd5b506105396108a6366004614eaa565b611921565b3480156108b757600080fd5b506104746108c6366004614b42565b60ca6020526000908152604090205481565b3480156108e457600080fd5b506104746108f3366004614b42565b63ffffffff16600090815260cb602052604090205490565b34801561091757600080fd5b506065546106a7906001600160a01b031681565b610474610939366004614eec565b611976565b34801561094a57600080fd5b506107eb610959366004614eec565b611999565b34801561096a57600080fd5b506109927f000000000000000000000000000000000000000000000000000000000000000081565b60405163ffffffff909116815260200161047e565b3480156109b357600080fd5b506033546001600160a01b03166106a7565b3480156109d157600080fd5b506105396109e0366004614c30565b611b14565b3480156109f157600080fd5b50610539610a00366004614b11565b611c5c565b348015610a1157600080fd5b5061049c6040518060400160405280600681526020016531312e302e3160d01b81525081565b348015610a4357600080fd5b50610474610a52366004614e85565b611c70565b348015610a6357600080fd5b5061049c611c8a565b348015610a7857600080fd5b506106a77f000000000000000000000000000000000000000000000000000000000000000081565b348015610aac57600080fd5b506104747f000000000000000000000000000000000000000000000000000000000000000081565b348015610ae057600080fd5b506104e9610aef366004614ae5565b611c99565b348015610b0057600080fd5b506104e9610b0f366004614ae5565b611d1f565b348015610b2057600080fd5b50610539610b2f366004614f1f565b611d2d565b348015610b4057600080fd5b50610474610b4f366004614ab7565b611da3565b348015610b6057600080fd5b50610474610b6f366004614f94565b611db0565b348015610b8057600080fd5b50610539610b8f366004614c9c565b611e24565b348015610ba057600080fd5b50610474610baf366004614f94565b611e36565b348015610bc057600080fd5b50610539610bcf366004614fcb565b611eaa565b348015610be057600080fd5b50610539610bef366004614b42565b611fc8565b348015610c0057600080fd5b50610590611fe7565b348015610c1557600080fd5b50610474610c24366004614ab7565b611ff3565b348015610c3557600080fd5b50610474610c44366004614b11565b612000565b348015610c5557600080fd5b506106a77f000000000000000000000000000000000000000000000000000000000000000081565b348015610c8957600080fd5b50610474610c98366004614b11565b612024565b610474610cab366004614db4565b612042565b348015610cbc57600080fd5b50610474610ccb366004614ffb565b61237f565b348015610cdc57600080fd5b506066546001600160a01b03166106a7565b348015610cfa57600080fd5b506104e9610d09366004614c9c565b6123aa565b348015610d1a57600080fd5b50610539610d29366004614b11565b6123d0565b348015610d3a57600080fd5b50610d4e610d49366004614b42565b6124a5565b60405161047e9190615019565b348015610d6757600080fd5b50610539610d76366004614c30565b6124c7565b348015610d8757600080fd5b50610539610d96366004614b42565b612576565b348015610da757600080fd5b506106a7612587565b610539610dbe366004614ab7565b6125af565b348015610dcf57600080fd5b50610474610dde366004614b42565b612606565b348015610def57600080fd5b50610539610dfe366004614b11565b612636565b348015610e0f57600080fd5b50610539610e1e366004614ffb565b6126ac565b348015610e2f57600080fd5b50610539610e3e366004614cf6565b6126ca565b348015610e4f57600080fd5b507f00000000000000000000000000000000000000000000000000000000000000006106a7565b606060d28054610e8590615051565b80601f0160208091040260200160405190810160405280929190818152602001828054610eb190615051565b8015610efe5780601f10610ed357610100808354040283529160200191610efe565b820191906000526020600020905b815481529060010190602001808311610ee157829003601f168201915b5050505050905090565b6000610f158260006126e6565b92915050565b600033610f29818585612722565b5060019392505050565b6000610f15826001612846565b610f48612872565b610f5360cd826128cc565b5050565b806001600160a01b0381163b151580610f7757506001600160a01b038116155b610f9c5760405162461bcd60e51b8152600401610f939061508b565b60405180910390fd5b610fa4612872565b606680546001600160a01b0319166001600160a01b0384169081179091556040519081527fc47cbcc588c67679e52261c45cc315e56562f8d0ccaba16facb9093ff9498799906020015b60405180910390a15050565b63ffffffff8116600090815260cc60205260409020606090610f15906128e1565b6000336110298582856128ee565b611034858585612962565b60019150505b9392505050565b611049612872565b82811461108e5760405162461bcd60e51b815260206004820152601360248201527209a867440d8cadccee8d040dad2e6dac2e8c6d606b1b6044820152606401610f93565b60005b83811015611189576111098383838181106110ae576110ae6150d2565b9050602002013561013460008888868181106110cc576110cc6150d2565b90506020020160208101906110e19190614b42565b63ffffffff1663ffffffff168152602001908152602001600020612b0d90919063ffffffff16565b1561118157828282818110611120576111206150d2565b90506020020135858583818110611139576111396150d2565b905060200201602081019061114e9190614b42565b63ffffffff167f50f2ff5d2aecb68a5747b2c222d14e5f8d49a1e00bc6df7ef943af8e3643926560405160405180910390a35b600101611091565b5050505050565b611198612872565b6111a182612b19565b5063ffffffff909116600090815260cb6020526040902055565b6000806111d2609763ffffffff80861690612b6416565b949350505050565b600080610101546111f59190600160a01b900460ff166150fe565b905090565b600033610f2981858561120d838361237f565b6112179190615117565b612722565b806001600160a01b0381163b15158061123c57506001600160a01b038116155b6112585760405162461bcd60e51b8152600401610f939061508b565b611260612872565b606580546001600160a01b0319166001600160a01b0384169081179091556040519081527f4eab7b127c764308788622363ad3e9532de3dfba7845bd4f84c125a22544255a90602001610fee565b6112b6612872565b610f5360cd82612b7d565b60606111f56097612b92565b60007f721d42344eebce0a76684e8fddd9c81a84afda39f3019e5a078a53853f098d115b546001600160a01b0316919050565b611308612872565b610f538282612c43565b61131a612872565b610f538282612ccd565b6001600160a01b037f00000000000000000000000000000000000000000000000000000000000000001633036113a85761135e8484612d8e565b80611387575063ffffffff808516600090815261013460205260409020611387918590612da216565b6113a35760405162461bcd60e51b8152600401610f939061512a565b611407565b6113eb3363ffffffff7f000000000000000000000000000000000000000000000000000000000000000081166000908152610134602052604090209190612da216565b6114075760405162461bcd60e51b8152600401610f939061512a565b61141384848484612dba565b50505050565b60408051600380825260808201909252606091816020015b60408051808201909152600080825260208201528152602001906001900390816114315790505090506000806114656115d7565b90507f000000000000000000000000000000000000000000000000000000000000000063ffffffff168763ffffffff16146114b1576114ae87876114a888612e31565b84612e7f565b91505b6040518060400160405280826001600160a01b0316815260200183815250836000815181106114e2576114e26150d2565b602002602001018190525060006114fb88888888612eb4565b91505060405180604001604052806115307f000000000000000000000000000000000000000000000000000000000000000090565b6001600160a01b031681526020016115488389615117565b8152508460018151811061155e5761155e6150d2565b6020026020010181905250604051806040016040528061159b7f000000000000000000000000000000000000000000000000000000000000000090565b6001600160a01b031681526020016000815250846002815181106115c1576115c16150d2565b6020026020010181905250505050949350505050565b6000806115e2612587565b6001600160a01b0316036115f65750600090565b507f000000000000000000000000000000000000000000000000000000000000000090565b61162660cd3361304e565b6116695760405162461bcd60e51b815260206004820152601460248201527326a1a91d1027b7363c902932b130b630b731b2b960611b6044820152606401610f93565b63ffffffff808416600090815260cc602052604090208491839190611692908290849061304e16565b6116de5760405162461bcd60e51b815260206004820152601760248201527f4d43523a204e6f7420616c6c6f776564206272696467650000000000000000006044820152606401610f93565b60006116e987613070565b6040516345ec85c160e11b815263ffffffff8916600482015260248101829052604481018890529091506000906001600160a01b03871690638bd90b8290606401600060405180830381865afa158015611747573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f1916820160405261176f91908101906151d1565b9050600061179d827f0000000000000000000000000000000000000000000000000000000000000000613099565b9050878111156117b9576117b96117b4898361529c565b613117565b60006117c58382613099565b9050478111156118235760405162461bcd60e51b8152602060048201526024808201527f526562616c616e6365206e61746976652066656520657863656564732062616c604482015263616e636560e01b6064820152608401610f93565b60405163206d3a2d60e21b815263ffffffff8b16600482015260248101859052604481018a90526001600160a01b038916906381b4e8b490839060640160206040518083038185885af115801561187e573d6000803e3d6000fd5b50505050506040513d601f19601f820116820180604052508101906118a391906152af565b5060408051858152602081018b9052339163ffffffff8d16917fb1e1b117ddf429b1b8a359fe0e978f0ae191c0f70e0babfea7acaad1b0ee8a2d910160405180910390a350505050505050505050565b6000806118ff84611ff3565b905061103a3384868461314a565b611915612872565b61191f60006131d2565b565b611929612872565b8060005b818110156114135761196484848381811061194a5761194a6150d2565b905060200201602081019061195f9190614b42565b613224565b61196f600182615117565b905061192d565b60008061198285612b19565b905061199085858584612042565b95945050505050565b606060006119a56115d7565b60408051600380825260808201909252919250816020015b60408051808201909152600080825260208201528152602001906001900390816119bd5790505091506040518060400160405280826001600160a01b03168152602001611a0c87878786612e7f565b81525082600081518110611a2257611a226150d2565b60200260200101819052506000611a3a868686613258565b9150506040518060400160405280611a6f7f000000000000000000000000000000000000000000000000000000000000000090565b6001600160a01b03168152602001611a878387615117565b81525083600181518110611a9d57611a9d6150d2565b60200260200101819052506040518060400160405280611ada7f000000000000000000000000000000000000000000000000000000000000000090565b6001600160a01b03168152602001600081525083600281518110611b0057611b006150d2565b602002602001018190525050509392505050565b611b1c612872565b828114611b615760405162461bcd60e51b815260206004820152601360248201527209a867440d8cadccee8d040dad2e6dac2e8c6d606b1b6044820152606401610f93565b60005b8381101561118957611bdc838383818110611b8157611b816150d2565b905060200201356101346000888886818110611b9f57611b9f6150d2565b9050602002016020810190611bb49190614b42565b63ffffffff1663ffffffff1681526020019081526020016000206133fc90919063ffffffff16565b15611c5457828282818110611bf357611bf36150d2565b90506020020135858583818110611c0c57611c0c6150d2565b9050602002016020810190611c219190614b42565b63ffffffff167fd68ae398d7c894590fe1cc029a8141af08d20bf2d2b7888841d8c8d5dba2b3dd60405160405180910390a35b600101611b64565b611c64612872565b611c6d81613408565b50565b600080611c7c84611da3565b905061103a3384838761314a565b606060d38054610e8590615051565b60003381611ca7828661237f565b905083811015611d075760405162461bcd60e51b815260206004820152602560248201527f45524332303a2064656372656173656420616c6c6f77616e63652062656c6f77604482015264207a65726f60d81b6064820152608401610f93565b611d148286868403612722565b506001949350505050565b600033610f29818585612962565b611d35612872565b60005b81811015611d9e57611d8c838383818110611d5557611d556150d2565b611d6b9260206040909202019081019150614b42565b848484818110611d7d57611d7d6150d2565b90506040020160200135612c43565b611d97600182615117565b9050611d38565b505050565b6000610f158260016126e6565b6000611dbb82612000565b841115611e0a5760405162461bcd60e51b815260206004820152601f60248201527f455243343632363a207769746864726177206d6f7265207468616e206d6178006044820152606401610f93565b6000611e1585610f33565b90506111d23385858885613476565b611e2c612872565b610f53828261352e565b6000611e4182612024565b841115611e905760405162461bcd60e51b815260206004820152601d60248201527f455243343632363a2072656465656d206d6f7265207468616e206d61780000006044820152606401610f93565b6000611e9b85610f08565b90506111d23385858489613476565b600054610100900460ff1615808015611eca5750600054600160ff909116105b80611ee45750303b158015611ee4575060005460ff166001145b611f475760405162461bcd60e51b815260206004820152602e60248201527f496e697469616c697a61626c653a20636f6e747261637420697320616c72656160448201526d191e481a5b9a5d1a585b1a5e995960921b6064820152608401610f93565b6000805460ff191660011790558015611f6a576000805461ff0019166101001790555b611f75848484613544565b611f7d61358e565b8015611413576000805461ff0019169055604051600181527f7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb38474024989060200160405180910390a150505050565b611fd0612872565b63ffffffff16600090815260cb6020526040812055565b60606111f560cd6128e1565b6000610f15826000612846565b6001600160a01b038116600090815260cf6020526040812054610f159060006126e6565b6001600160a01b038116600090815260cf6020526040812054610f15565b600061204e8583612d8e565b80612077575063ffffffff808616600090815261013460205260409020612077918490612da216565b6120935760405162461bcd60e51b8152600401610f939061512a565b7f000000000000000000000000000000000000000000000000000000000000000063ffffffff168563ffffffff16036121145734156121145760405162461bcd60e51b815260206004820152601f60248201527f4d433a206c6f63616c207472616e73666572206e6f206d73672e76616c7565006044820152606401610f93565b600061212386868634876135de565b915050600061213185612e31565b604080516020810189905280820183905281518082038301815260609091019091529091507f000000000000000000000000000000000000000000000000000000000000000063ffffffff168863ffffffff160361227857600061219486613733565b90506000816001600160a01b03163b116121f05760405162461bcd60e51b815260206004820152601e60248201527f4d433a2074617267657420726f75746572206e6f7420636f6e747261637400006044820152606401610f93565b6040516356d5d47560e01b81526001600160a01b038216906356d5d47590612240907f000000000000000000000000000000000000000000000000000000000000000090309087906004016152c8565b600060405180830381600087803b15801561225a57600080fd5b505af115801561226e573d6000803e3d6000fd5b5050505050612374565b868863ffffffff167fd229aacb94204188fe8042965fa6b269c62dc5818b21238779ab64bdd17efeec846040516122b191815260200190565b60405180910390a37f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03166310b83dc0848a88856122fd8e6122f86115d7565b61379c565b6065546040516001600160e01b031960e089901b16815261232e95949392916001600160a01b0316906004016152ed565b60206040518083038185885af115801561234c573d6000803e3d6000fd5b50505050506040513d601f19601f8201168201806040525081019061237191906152af565b93505b505050949350505050565b6001600160a01b03918216600090815260d06020908152604080832093909416825291909152205490565b63ffffffff808316600090815261013460205260408120909161103a91908490612da216565b6123d8612872565b306001600160a01b038216036124305760405162461bcd60e51b815260206004820152601c60248201527f46656520726563697069656e742063616e6e6f742062652073656c66000000006044820152606401610f93565b807f721d42344eebce0a76684e8fddd9c81a84afda39f3019e5a078a53853f098d1180546001600160a01b0319166001600160a01b0392831617905560405190821681527fbf9a9534339a9d6b81696e05dcfb614b7dc518a31d48be3cfb757988381fb323906020015b60405180910390a150565b63ffffffff8116600090815261013460205260409020606090610f15906128e1565b6124cf612872565b8281146125085760405162461bcd60e51b8152602060048201526007602482015266042d8cadccee8d60cb1b6044820152606401610f93565b8260005b8181101561256e5761255c868683818110612529576125296150d2565b905060200201602081019061253e9190614b42565b858584818110612550576125506150d2565b9050602002013561352e565b612567600182615117565b905061250c565b505050505050565b61257e612872565b611c6d81613224565b60007fe797cab0ddd50f45c2a522220a721ebb6d0f53785d8595512b6122e7164a201f6112f1565b6125b881613117565b8061013360008282546125cb9190615117565b909155505060408051338152602081018390527f5d8bc849764969eb1bcc6d0a2f55999d0167c1ccec240a4f39cf664ca9c4148e910161249a565b6000610f158260405180602001604052806000815250612625856137c1565b6065546001600160a01b03166137e3565b61263e612872565b6001600160a01b0381166126a35760405162461bcd60e51b815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201526564647265737360d01b6064820152608401610f93565b611c6d816131d2565b6126b4612872565b610f536001600160a01b03831682600019613891565b6126d2612872565b6126db82612b19565b50610f5382826139d9565b600061103a6126f56101335490565b612700906001615117565b61270c6000600a61541b565b60d1546127199190615117565b85919085613a19565b6001600160a01b0383166127845760405162461bcd60e51b8152602060048201526024808201527f45524332303a20617070726f76652066726f6d20746865207a65726f206164646044820152637265737360e01b6064820152608401610f93565b6001600160a01b0382166127e55760405162461bcd60e51b815260206004820152602260248201527f45524332303a20617070726f766520746f20746865207a65726f206164647265604482015261737360f01b6064820152608401610f93565b6001600160a01b03838116600081815260d0602090815260408083209487168084529482529182902085905590518481527f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925910160405180910390a3505050565b600061103a61285682600a61541b565b60d1546128639190615117565b61013354612719906001615117565b6033546001600160a01b0316331461191f5760405162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e65726044820152606401610f93565b600061103a836001600160a01b038416613a6a565b6060600061103a83613ab9565b60006128fa848461237f565b9050600019811461141357818110156129555760405162461bcd60e51b815260206004820152601d60248201527f45524332303a20696e73756666696369656e7420616c6c6f77616e63650000006044820152606401610f93565b6114138484848403612722565b6001600160a01b0383166129c65760405162461bcd60e51b815260206004820152602560248201527f45524332303a207472616e736665722066726f6d20746865207a65726f206164604482015264647265737360d81b6064820152608401610f93565b6001600160a01b038216612a285760405162461bcd60e51b815260206004820152602360248201527f45524332303a207472616e7366657220746f20746865207a65726f206164647260448201526265737360e81b6064820152608401610f93565b6001600160a01b038316600090815260cf602052604090205481811015612aa05760405162461bcd60e51b815260206004820152602660248201527f45524332303a207472616e7366657220616d6f756e7420657863656564732062604482015265616c616e636560d01b6064820152608401610f93565b6001600160a01b03808516600081815260cf602052604080822086860390559286168082529083902080548601905591517fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef90612b009086815260200190565b60405180910390a3611413565b600061103a8383613a6a565b60008080612b31609763ffffffff80871690612b6416565b915091508115612b42579392505050565b612b4b84613b15565b60405162461bcd60e51b8152600401610f939190614aa4565b600080612b718484613b4c565b915091505b9250929050565b600061103a836001600160a01b038416613b8e565b60606000612b9f83613c81565b9050805167ffffffffffffffff811115612bbb57612bbb615161565b604051908082528060200260200182016040528015612be4578160200160208202803683370190505b50915060005b8151811015612c3c57818181518110612c0557612c056150d2565b6020026020010151838281518110612c1f57612c1f6150d2565b63ffffffff90921660209283029190910190910152600101612bea565b5050919050565b612c57609763ffffffff80851690613d1216565b612c6083613b15565b90612c7e5760405162461bcd60e51b8152600401610f939190614aa4565b5063ffffffff8216600081815260ca6020908152604091829020849055815192835282018390527fc3de732a98b24a2b5c6f67e8a7fb057ffc14046b83968a2c73e4148d2fba978b9101610fee565b612cd78282613d1e565b6000612ce36097612b92565b905060005b8151811015612d5857600060cb6001016000848481518110612d0c57612d0c6150d2565b602002602001015163ffffffff1663ffffffff1681526020019081526020016000209050612d43848261304e90919063ffffffff16565b15612d4f575050505050565b50600101612ce8565b50611d9e6001600160a01b037f000000000000000000000000000000000000000000000000000000000000000016836000613d40565b600081612d9a846111bb565b149392505050565b6000818152600183016020526040812054151561103a565b6000612dc68383613dcf565b90506000612dd48484613df8565b9050818663ffffffff167fba20947a325f450d232530e5f5fce293e7963499d5309a07cee84a269f2f15a683604051612e0f91815260200190565b60405180910390a361256e612e2383613733565b612e2c83613e08565b613e56565b6000610f15827f00000000000000000000000000000000000000000000000000000000000000007f000000000000000000000000000000000000000000000000000000000000000084613a19565b60408051602081018590528082018490528151808203830181526060909101909152600090611990908690612625888661379c565b600080612ebf6112cd565b91506001600160a01b038216612ed757506000613045565b60405163183b50e360e21b815263ffffffff871660048201526024810186905260448101859052606481018490526000906001600160a01b038416906360ed438c90608401600060405180830381865afa158015612f39573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052612f6191908101906151d1565b90508051600003612f76575060009050613045565b80516001148015612fd657507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031681600081518110612fbf57612fbf6150d2565b6020026020010151600001516001600160a01b0316145b6130225760405162461bcd60e51b815260206004820152601860248201527f4d433a20666565206d757374206d6174636820746f6b656e00000000000000006044820152606401610f93565b80600081518110613035576130356150d2565b6020026020010151602001519150505b94509492505050565b6001600160a01b0381166000908152600183016020526040812054151561103a565b63ffffffff8116600090815260cb60205260409020548061309457610f1582612b19565b919050565b6000805b835181101561311057826001600160a01b03168482815181106130c2576130c26150d2565b6020026020010151600001516001600160a01b031603613108578381815181106130ee576130ee6150d2565b602002602001015160200151826131059190615117565b91505b60010161309d565b5092915050565b611c6d6001600160a01b037f00000000000000000000000000000000000000000000000000000000000000001682613e8a565b61315382613117565b8161013360008282546131669190615117565b9091555061317690508382613e9f565b826001600160a01b0316846001600160a01b03167fdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d784846040516131c4929190918252602082015260400190565b60405180910390a350505050565b603380546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b63ffffffff8116600090815260cb6020908152604080832083905560cc909152902061324f90613f60565b611c6d81613fb8565b6000806132636112cd565b91506001600160a01b03821661327b575060006133f4565b6040516345ec85c160e11b815263ffffffff8616600482015260248101859052604481018490526000906001600160a01b03841690638bd90b8290606401600060405180830381865afa1580156132d6573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526132fe91908101906151d1565b905080516000036133135750600090506133f4565b8051600114801561337357507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168160008151811061335c5761335c6150d2565b6020026020010151600001516001600160a01b0316145b6133d15760405162461bcd60e51b815260206004820152602960248201527f46756e6769626c65546f6b656e526f757465723a20666565206d757374206d616044820152683a31b4103a37b5b2b760b91b6064820152608401610f93565b806000815181106133e4576133e46150d2565b6020026020010151602001519150505b935093915050565b600061103a8383613b8e565b807fe797cab0ddd50f45c2a522220a721ebb6d0f53785d8595512b6122e7164a201f80546001600160a01b0319166001600160a01b0392831617905560405190821681527fd6e2f80c31feccfd7c896d69ad9963871021131ff84f2a9828b40bad60dd8cb49060200161249a565b826001600160a01b0316856001600160a01b03161461349a5761349a8386836128ee565b6134a48382613ff3565b8161013360008282546134b7919061529c565b909155506134c790508483613e56565b826001600160a01b0316846001600160a01b0316866001600160a01b03167ffbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db858560405161351f929190918252602082015260400190565b60405180910390a45050505050565b610f53609763ffffffff80851690849061412716565b600054610100900460ff1661356b5760405162461bcd60e51b8152600401610f939061542a565b613573614132565b61357c8361121c565b61358582610f57565b611d9e816131d2565b600054610100900460ff166135b55760405162461bcd60e51b8152600401610f939061542a565b61191f7f0000000000000000000000000000000000000000000000000000000000000000614161565b6000806000806135f089898988612eb4565b909250905060009350600084613606838a615117565b6136109190615117565b9050600061361c612587565b90507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0382161580159061368357507f000000000000000000000000000000000000000000000000000000000000000063ffffffff168c63ffffffff1614155b156136ea5760006136968d8d8d85612e7f565b905080156136e8576001600160a01b03821630146136bf576136b88185615117565b93506136d4565b6136d46001600160a01b038316333084614191565b6136e86001600160a01b0383168483613d40565b505b6136f383613117565b83156137035761370385856141c9565b6001600160a01b0381166137205761371b838a61529c565b613722565b885b955050505050509550959350505050565b60006001600160a01b038211156137985760405162461bcd60e51b8152602060048201526024808201527f5479706543617374733a2062797465733332546f41646472657373206f766572604482015263666c6f7760e01b6064820152608401610f93565b5090565b63ffffffff8216600090815260ca60205260408120546060916111d2908233866141d3565b63ffffffff8116600090815260ca6020526040902054606090610f1590614230565b6000806137ef86612b19565b6040516381d2ea9560e01b81529091506001600160a01b037f000000000000000000000000000000000000000000000000000000000000000016906381d2ea959061384690899085908a908a908a906004016152ed565b602060405180830381865afa158015613863573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061388791906152af565b9695505050505050565b80158061390b5750604051636eb1769f60e11b81523060048201526001600160a01b03838116602483015284169063dd62ed3e90604401602060405180830381865afa1580156138e5573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061390991906152af565b155b6139765760405162461bcd60e51b815260206004820152603660248201527f5361666545524332303a20617070726f76652066726f6d206e6f6e2d7a65726f60448201527520746f206e6f6e2d7a65726f20616c6c6f77616e636560501b6064820152608401610f93565b6040516001600160a01b038316602482015260448101829052611d9e90849063095ea7b360e01b906064015b60408051601f198184030181529190526020810180516001600160e01b03166001600160e01b03199093169290921790915261424e565b6139e38282614323565b610f536001600160a01b037f00000000000000000000000000000000000000000000000000000000000000001682600019613d40565b600080613a27868686614345565b90506001836002811115613a3d57613a3d615475565b148015613a5a575060008480613a5557613a5561548b565b868809115b1561199057613887600182615117565b6000818152600183016020526040812054613ab157508154600181810184556000848152602080822090930184905584548482528286019093526040902091909155610f15565b506000610f15565b606081600001805480602002602001604051908101604052809291908181526020018280548015613b0957602002820191906000526020600020905b815481526020019060010190808311613af5575b50505050509050919050565b6060613b268263ffffffff1661442f565b604051602001613b3691906154a1565b6040516020818303038152906040529050919050565b6000818152600283016020526040812054819080613b7b57613b6e85856144c2565b925060009150612b769050565b600192509050612b76565b509250929050565b60008181526001830160205260408120548015613c77576000613bb260018361529c565b8554909150600090613bc69060019061529c565b9050818114613c2b576000866000018281548110613be657613be66150d2565b9060005260206000200154905080876000018481548110613c0957613c096150d2565b6000918252602080832090910192909255918252600188019052604090208390555b8554869080613c3c57613c3c6154e6565b600190038181906000526020600020016000905590558560010160008681526020019081526020016000206000905560019350505050610f15565b6000915050610f15565b60606000613c8e836144ce565b90508067ffffffffffffffff811115613ca957613ca9615161565b604051908082528060200260200182016040528015613cd2578160200160208202803683370190505b50915060005b81811015612c3c57613cea84826144d9565b60001c838281518110613cff57613cff6150d2565b6020908102919091010152600101613cd8565b600061103a83836144c2565b63ffffffff808316600090815260cc60205260409020611d9e918390612b7d16565b604080516001600160a01b038416602482015260448082018490528251808303909101815260649091019091526020810180516001600160e01b031663095ea7b360e01b179052613d9184826144e5565b611413576040516001600160a01b038416602482015260006044820152613dc590859063095ea7b360e01b906064016139a2565b611413848261424e565b6000828183613ddf8260206150fe565b60ff1692613def939291906154fc565b61103a91615526565b600082602083613ddf82806150fe565b6000610f15827f00000000000000000000000000000000000000000000000000000000000000007f000000000000000000000000000000000000000000000000000000000000000084613a19565b610f536001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000168383614588565b610f536001600160a01b038316333084614191565b6001600160a01b038216613ef55760405162461bcd60e51b815260206004820152601f60248201527f45524332303a206d696e7420746f20746865207a65726f2061646472657373006044820152606401610f93565b8060d16000828254613f079190615117565b90915550506001600160a01b038216600081815260cf60209081526040808320805486019055518481527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a35050565b805460005b81811015613fb057826001016000846000018381548110613f8857613f886150d2565b9060005260206000200154815260200190815260200160002060009055806001019050613f65565b505060009055565b613fcc609763ffffffff8084169061459c16565b613fd582613b15565b90610f535760405162461bcd60e51b8152600401610f939190614aa4565b6001600160a01b0382166140535760405162461bcd60e51b815260206004820152602160248201527f45524332303a206275726e2066726f6d20746865207a65726f206164647265736044820152607360f81b6064820152608401610f93565b6001600160a01b038216600090815260cf6020526040902054818110156140c75760405162461bcd60e51b815260206004820152602260248201527f45524332303a206275726e20616d6f756e7420657863656564732062616c616e604482015261636560f01b6064820152608401610f93565b6001600160a01b038316600081815260cf60209081526040808320868603905560d180548790039055518581529192917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a3505050565b6114138383836145a8565b600054610100900460ff166141595760405162461bcd60e51b8152600401610f939061542a565b61191f6145c5565b600054610100900460ff166141885760405162461bcd60e51b8152600401610f939061542a565b611c6d816145f5565b6040516001600160a01b03808516602483015283166044820152606481018290526114139085906323b872dd60e01b906084016139a2565b610f538282613e56565b604051600160f01b60208201526022810185905260428101849052606083811b6bffffffffffffffffffffffff19908116606284015283821b16607683015290608a015b6040516020818303038152906040529050949350505050565b6060610f15600083336040518060200160405280600081525061467b565b60006142a3826040518060400160405280602081526020017f5361666545524332303a206c6f772d6c6576656c2063616c6c206661696c6564815250856001600160a01b03166146979092919063ffffffff16565b90508051600014806142c45750808060200190518101906142c49190615544565b611d9e5760405162461bcd60e51b815260206004820152602a60248201527f5361666545524332303a204552433230206f7065726174696f6e20646964206e6044820152691bdd081cdd58d8d9595960b21b6064820152608401610f93565b63ffffffff808316600090815260cc60205260409020611d9e9183906128cc16565b600080806000198587098587029250828110838203039150508060000361437f578382816143755761437561548b565b049250505061103a565b8084116143c65760405162461bcd60e51b81526020600482015260156024820152744d6174683a206d756c446976206f766572666c6f7760581b6044820152606401610f93565b60008486880960026001871981018816978890046003810283188082028403028082028403028082028403028082028403028082028403029081029092039091026000889003889004909101858311909403939093029303949094049190911702949350505050565b6060600061443c836146a6565b600101905060008167ffffffffffffffff81111561445c5761445c615161565b6040519080825280601f01601f191660200182016040528015614486576020820181803683370190505b5090508181016020015b600019016f181899199a1a9b1b9c1cb0b131b232b360811b600a86061a8153600a850494508461449057509392505050565b600061103a8383612da2565b6000610f158261477e565b600061103a8383614788565b6000806000846001600160a01b0316846040516145029190615566565b6000604051808303816000865af19150503d806000811461453f576040519150601f19603f3d011682016040523d82523d6000602084013e614544565b606091505b509150915081801561456e57508051158061456e57508080602001905181019061456e9190615544565b80156119905750505050506001600160a01b03163b151590565b611d9e6001600160a01b03841683836147b2565b600061103a83836147e2565b600082815260028401602052604081208290556111d28484612b0d565b600054610100900460ff166145ec5760405162461bcd60e51b8152600401610f939061542a565b61191f336131d2565b600054610100900460ff1661461c5760405162461bcd60e51b8152600401610f939061542a565b600080614628836147ff565b915091508161463857601261463a565b805b61010180546001600160a01b039095166001600160a01b031960ff93909316600160a01b02929092166001600160a81b031990951694909417179092555050565b6060600185858585604051602001614217959493929190615582565b60606111d284846000856148db565b60008072184f03e93ff9f4daa797ed6e38ed64bf6a1f0160401b83106146e55772184f03e93ff9f4daa797ed6e38ed64bf6a1f0160401b830492506040015b6d04ee2d6d415b85acef81000000008310614711576d04ee2d6d415b85acef8100000000830492506020015b662386f26fc10000831061472f57662386f26fc10000830492506010015b6305f5e1008310614747576305f5e100830492506008015b612710831061475b57612710830492506004015b6064831061476d576064830492506002015b600a8310610f155760010192915050565b6000610f15825490565b600082600001828154811061479f5761479f6150d2565b9060005260206000200154905092915050565b6040516001600160a01b038316602482015260448101829052611d9e90849063a9059cbb60e01b906064016139a2565b6000818152600283016020526040812081905561103a83836133fc565b60408051600481526024810182526020810180516001600160e01b031663313ce56760e01b17905290516000918291829182916001600160a01b0387169161484691615566565b600060405180830381855afa9150503d8060008114614881576040519150601f19603f3d011682016040523d82523d6000602084013e614886565b606091505b509150915081801561489a57506020815110155b156148ce576000818060200190518101906148b591906152af565b905060ff81116148cc576001969095509350505050565b505b5060009485945092505050565b60608247101561493c5760405162461bcd60e51b815260206004820152602660248201527f416464726573733a20696e73756666696369656e742062616c616e636520666f6044820152651c8818d85b1b60d21b6064820152608401610f93565b600080866001600160a01b031685876040516149589190615566565b60006040518083038185875af1925050503d8060008114614995576040519150601f19603f3d011682016040523d82523d6000602084013e61499a565b606091505b50915091506149ab878383876149b6565b979650505050505050565b60608315614a25578251600003614a1e576001600160a01b0385163b614a1e5760405162461bcd60e51b815260206004820152601d60248201527f416464726573733a2063616c6c20746f206e6f6e2d636f6e74726163740000006044820152606401610f93565b50816111d2565b6111d28383815115614a3a5781518083602001fd5b8060405162461bcd60e51b8152600401610f939190614aa4565b60005b83811015614a6f578181015183820152602001614a57565b50506000910152565b60008151808452614a90816020860160208601614a54565b601f01601f19169290920160200192915050565b60208152600061103a6020830184614a78565b600060208284031215614ac957600080fd5b5035919050565b6001600160a01b0381168114611c6d57600080fd5b60008060408385031215614af857600080fd5b8235614b0381614ad0565b946020939093013593505050565b600060208284031215614b2357600080fd5b813561103a81614ad0565b803563ffffffff8116811461309457600080fd5b600060208284031215614b5457600080fd5b61103a82614b2e565b6020808252825182820181905260009190848201906040850190845b81811015614b9e5783516001600160a01b031683529284019291840191600101614b79565b50909695505050505050565b600080600060608486031215614bbf57600080fd5b8335614bca81614ad0565b92506020840135614bda81614ad0565b929592945050506040919091013590565b60008083601f840112614bfd57600080fd5b50813567ffffffffffffffff811115614c1557600080fd5b6020830191508360208260051b8501011115612b7657600080fd5b60008060008060408587031215614c4657600080fd5b843567ffffffffffffffff80821115614c5e57600080fd5b614c6a88838901614beb565b90965094506020870135915080821115614c8357600080fd5b50614c9087828801614beb565b95989497509550505050565b60008060408385031215614caf57600080fd5b614b0383614b2e565b6020808252825182820181905260009190848201906040850190845b81811015614b9e57835163ffffffff1683529284019291840191600101614cd4565b60008060408385031215614d0957600080fd5b614d1283614b2e565b91506020830135614d2281614ad0565b809150509250929050565b60008060008060608587031215614d4357600080fd5b614d4c85614b2e565b935060208501359250604085013567ffffffffffffffff80821115614d7057600080fd5b818701915087601f830112614d8457600080fd5b813581811115614d9357600080fd5b886020828501011115614da557600080fd5b95989497505060200194505050565b60008060008060808587031215614dca57600080fd5b614dd385614b2e565b966020860135965060408601359560600135945092505050565b602080825282518282018190526000919060409081850190868401855b82811015614e3857815180516001600160a01b03168552860151868501529284019290850190600101614e0a565b5091979650505050505050565b600080600060608486031215614e5a57600080fd5b614e6384614b2e565b9250602084013591506040840135614e7a81614ad0565b809150509250925092565b60008060408385031215614e9857600080fd5b823591506020830135614d2281614ad0565b60008060208385031215614ebd57600080fd5b823567ffffffffffffffff811115614ed457600080fd5b614ee085828601614beb565b90969095509350505050565b600080600060608486031215614f0157600080fd5b614f0a84614b2e565b95602085013595506040909401359392505050565b60008060208385031215614f3257600080fd5b823567ffffffffffffffff80821115614f4a57600080fd5b818501915085601f830112614f5e57600080fd5b813581811115614f6d57600080fd5b8660208260061b8501011115614f8257600080fd5b60209290920196919550909350505050565b600080600060608486031215614fa957600080fd5b833592506020840135614fbb81614ad0565b91506040840135614e7a81614ad0565b600080600060608486031215614fe057600080fd5b8335614feb81614ad0565b92506020840135614fbb81614ad0565b6000806040838503121561500e57600080fd5b8235614d1281614ad0565b6020808252825182820181905260009190848201906040850190845b81811015614b9e57835183529284019291840191600101615035565b600181811c9082168061506557607f821691505b60208210810361508557634e487b7160e01b600052602260045260246000fd5b50919050565b60208082526027908201527f4d61696c626f78436c69656e743a20696e76616c696420636f6e74726163742060408201526673657474696e6760c81b606082015260800190565b634e487b7160e01b600052603260045260246000fd5b634e487b7160e01b600052601160045260246000fd5b60ff8181168382160190811115610f1557610f156150e8565b80820180821115610f1557610f156150e8565b60208082526017908201527f4d433a20756e617574686f72697a656420726f75746572000000000000000000604082015260600190565b634e487b7160e01b600052604160045260246000fd5b6040805190810167ffffffffffffffff8111828210171561519a5761519a615161565b60405290565b604051601f8201601f1916810167ffffffffffffffff811182821017156151c9576151c9615161565b604052919050565b600060208083850312156151e457600080fd5b825167ffffffffffffffff808211156151fc57600080fd5b818501915085601f83011261521057600080fd5b81518181111561522257615222615161565b615230848260051b016151a0565b818152848101925060069190911b83018401908782111561525057600080fd5b928401925b818410156149ab576040848903121561526e5760008081fd5b615276615177565b845161528181614ad0565b81528486015186820152835260409093019291840191615255565b81810381811115610f1557610f156150e8565b6000602082840312156152c157600080fd5b5051919050565b63ffffffff841681528260208201526060604082015260006119906060830184614a78565b63ffffffff8616815284602082015260a06040820152600061531260a0830186614a78565b82810360608401526153248186614a78565b91505060018060a01b03831660808301529695505050505050565b600181815b80851115613b86578160001904821115615360576153606150e8565b8085161561536d57918102915b93841c9390800290615344565b60008261538957506001610f15565b8161539657506000610f15565b81600181146153ac57600281146153b6576153d2565b6001915050610f15565b60ff8411156153c7576153c76150e8565b50506001821b610f15565b5060208310610133831016604e8410600b84101617156153f5575081810a610f15565b6153ff838361533f565b8060001904821115615413576154136150e8565b029392505050565b600061103a60ff84168361537a565b6020808252602b908201527f496e697469616c697a61626c653a20636f6e7472616374206973206e6f74206960408201526a6e697469616c697a696e6760a81b606082015260800190565b634e487b7160e01b600052602160045260246000fd5b634e487b7160e01b600052601260045260246000fd5b7f4e6f20726f7574657220656e726f6c6c656420666f7220646f6d61696e3a20008152600082516154d981601f850160208701614a54565b91909101601f0192915050565b634e487b7160e01b600052603160045260246000fd5b6000808585111561550c57600080fd5b8386111561551957600080fd5b5050820193919092039150565b80356020831015610f1557600019602084900360031b1b1692915050565b60006020828403121561555657600080fd5b8151801515811461103a57600080fd5b60008251615578818460208701614a54565b9190910192915050565b61ffff60f01b8660f01b1681528460028201528360228201526bffffffffffffffffffffffff198360601b166042820152600082516155c8816056850160208701614a54565b91909101605601969550505050505056fea26469706673582212202440ce5daeb77838bd3ecb02da42505221ea2077f2eef27a839d767696a2a60464736f6c63430008160033",
};

type MultiCollateralMethods = ContractMethodMap<typeof MultiCollateralAbi>;

type MultiCollateralEstimateGasMethods = {
  [TName in keyof MultiCollateralMethods]: ViemContractLike<typeof MultiCollateralAbi>['estimateGas'][TName];
};

export type MultiCollateral = ViemContractLike<typeof MultiCollateralAbi> &
  MultiCollateralMethods & {
    estimateGas: ViemContractLike<typeof MultiCollateralAbi>['estimateGas'] &
      MultiCollateralEstimateGasMethods;
  };

export class MultiCollateral__factory extends ViemContractFactory<typeof MultiCollateralAbi, MultiCollateral> {
  static readonly artifact = MultiCollateralArtifact;

  static connect(address: string, runner?: RunnerLike): MultiCollateral {
    return super.connect(address, runner) as MultiCollateral;
  }
}
