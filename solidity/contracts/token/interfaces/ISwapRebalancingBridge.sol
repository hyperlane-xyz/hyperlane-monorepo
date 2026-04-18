// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Quote} from "../../interfaces/ITokenBridge.sol";

struct SwapCall {
    address target;
    address allowanceTarget;
    bytes data;
}

struct PendingRebalance {
    address initiator;
    address sourceRouter;
    address destinationRouter;
    address inputToken;
    address outputToken;
    uint32 localDomain;
    uint256 amountIn;
    uint256 minAmountOut;
    uint256 requiredOut;
    uint256 deadline;
}

interface ISwapRebalancingBridge {
    function executeRebalance(
        address sourceRouter,
        address destinationRouter,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        SwapCall[] calldata swapCalls
    ) external payable;

    function setAuthorizedRebalancer(address rebalancer, bool allowed) external;

    function setTarget(address target, bool allowed) external;

    function setAllowanceTarget(address target, bool allowed) external;

    function pendingRebalance() external view returns (PendingRebalance memory);

    function quoteTransferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external view returns (Quote[] memory);
}
