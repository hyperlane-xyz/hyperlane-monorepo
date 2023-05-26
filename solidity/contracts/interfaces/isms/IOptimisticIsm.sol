// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
    /**
     * @notice Pre-verifies _message using the currently configuered submodule
     * @dev before calling verify, the ISM will call preVerify to ensure that the message is valid
     * @param _metadata Formatted arbitrary bytes that can be specified by an off-chain relayer
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return Whether or not the message is valid
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool);

    /**
     * @notice Marks an ISM as fraudulent
     * @param ism The address of ISM to mark as fraudulent
     */
    function markFraudulent(address ism) external;
}
