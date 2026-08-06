// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge} from "../../interfaces/ITokenBridge.sol";

interface IRebalancingBridge {
    /**
     * @notice Execute a rebalance from `sourceRouter` into a recipient.
     * @dev `sourceRouter` must allow this bridge as a rebalancer and bridge.
     * @param domain The rebalance destination domain.
     * @param amount The amount of source collateral to move.
     * @param sourceRouter The collateral router the funds are pulled from.
     * @param destinationRecipient The recipient to fund; must be an allowed rebalance target of `sourceRouter`.
     * @param data Implementation-specific payload, e.g. the swap calls to run during the rebalance.
     */
    function rebalance(
        uint32 domain,
        uint256 amount,
        ITokenBridge sourceRouter,
        bytes32 destinationRecipient,
        bytes calldata data
    ) external payable;
}
