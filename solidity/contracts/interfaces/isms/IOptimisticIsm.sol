// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
    /**
     * @notice Returns whether or not the messages was pre-verified
     * @dev Can change based on the content of _message
     * @param _metadata Off-chain metadata provided by a relayer, specific to
     * the security model encoded by the module (e.g. validator signatures)
     * @param _message Hyperlane encoded interchain message
     * @return module The ISM to use to verify _message
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool);

    /**
     * @notice Called by a watcher when the submodule is marked as compromised
     * @dev Can be called by registered watchers
     * @param _submodule The address of the submodule to mark as compromised.
     */
    function markCompromised(address _submodule) external;

    /**
     * @notice Called by a watcher when the message is marked as compromised
     * @dev Can be called by registered watchers
     * @param _submodule The ID of the message to mark as fraudulent.
     */
    function markFraudulent(bytes32 _id) external;

    /**
     * @notice Returns the ISM responsible for pre-verifying _message
     * @dev Can change based by the contract owner
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to pre-verify _message
     */
    function submodule(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule);
}
