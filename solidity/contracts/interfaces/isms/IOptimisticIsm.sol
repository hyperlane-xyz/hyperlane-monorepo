// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
    /**
     * @notice Returns the set of watchers responsible for checking fraudulent _message
     * and the number of signatures to verify fraud
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return watchers The array of watcher addresses
     * @return threshold The number of signatures needed to verify
     */
    function watchersAndThreshold(bytes calldata _message)
        external
        view
        returns (address[] memory watchers, uint8 threshold);

    /**
     * @notice Returns the ISM that is responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return modules The ISM address
     */
    function getPreVerifyIsm(bytes calldata _message)
        external
        view
        returns (address);

    /**
     * @notice Requires that the set ISM has verified '_message'
     * @param _metadata ABI encoded module metadata (see OptimisticIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool);
}
