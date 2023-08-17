// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IPostDispatchHook {
    /**
     * @notice Post action afte a message is dispatched via the Mailbox
     * @param metadata The metadata required for the hook
     * @param message The message passed from the Mailbox.dispatch() call
     */
    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable;

    /**
     * @notice Estimate the amount of gas consumed by the postDispatch call
     * @param metadata The metadata required for the hook
     * @param message The message passed from the Mailbox.dispatch() call
     * @return Gas quote for the postDispatch call
     */
    function quoteDispatch(bytes calldata metadata, bytes calldata message)
        external
        view
        returns (uint256);
}
