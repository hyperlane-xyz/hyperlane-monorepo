// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";

/**
 * @title OptimisticIsm
 */

 abstract contract AbstractOptimisticIsm is IInterchainSecurityModule {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        public
        virtual
        returns (bool);

    function markFraudulent(address ism) public virtual;

    // ============ Public Functions ============

    /**
     * @notice Routes _metadata and _message to the correct ISM
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        return preVerify(_metadata, _message);
    }
 }