// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractOptimisticIsm} from "./AbstractOptimisticIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

/**
 * @title StaticMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used
 * to verify interchain messages.
 */
contract StaticOptimisticIsm is AbstractOptimisticIsm {
    // ============ Public Functions ============

    /**
     * @notice Returns the set of watchers responsible for checking fraudulent _message
     * and the number of signatures that must verify
     * @dev Can change based on the content of _message
     * @return watchers The array of watcher addresses
     * @return threshold The number of signatures needed to verify
     */
    function watchersAndThreshold(bytes calldata)
        public
        view
        virtual
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }

    /**
     * @notice Returns the ISM that is responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return modules The ISM address
     */
    function preVerifyIsm(bytes calldata _message)
        public
        view
        virtual
        override
        returns (address)
    {
        return abi.decode(MetaProxy.metadata(), (address));
    }
}
