// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "./hooks/IPostDispatchHook.sol";

interface IMailbox {
    // ============ Events ============
    /**
     * @notice Emitted when a new message is dispatched via Hyperlane
     * @param id The unique message identifier
     * @param message Raw bytes of message
     */
    event Dispatch(bytes32 indexed id, bytes message);

    /**
     * @notice Emitted when a Hyperlane message is delivered
     * @param id The unique message identifier
     * @param message Raw bytes of message
     */
    event Process(bytes32 indexed id, bytes message);

    function localDomain() external view returns (uint32);

    function delivered(bytes32 messageId) external view returns (bool);

    function defaultIsm() external view returns (IInterchainSecurityModule);

    function defaultHook() external view returns (IPostDispatchHook);

    function requiredHook() external view returns (IPostDispatchHook);

    function latestDispatchedId() external view returns (bytes32);

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external payable returns (bytes32 messageId);

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata body,
        bytes calldata defaultHookMetadata
    ) external payable returns (bytes32 messageId);

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata body,
        IPostDispatchHook customHook,
        bytes calldata customHookMetadata
    ) external payable returns (bytes32 messageId);

    function process(bytes calldata metadata, bytes calldata message)
        external
        payable;

    function recipientIsm(address recipient)
        external
        view
        returns (IInterchainSecurityModule module);
}
