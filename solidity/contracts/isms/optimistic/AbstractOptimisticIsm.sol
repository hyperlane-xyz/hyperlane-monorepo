// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {console} from "forge-std/console.sol";

// ============ Internal Imports ============
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {IMultisigIsm} from "../../interfaces/isms/IMultisigIsm.sol";
import {OptimisticIsmMetadata} from "../../libs/isms/OptimisticIsmMetadata.sol";

/**
 * @title OptimisticIsm
 * @notice Manages n per-domain ISM sets, any 1 of which is required
 * to verify interchain messages
 */
abstract contract AbstractOptimisticIsm is IOptimisticIsm {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MULTISIG);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

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
        returns (address);

    /**
     * @notice Returns the set of watchers responsible for checking fraud _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @return watchers The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function watchersAndThreshold(bytes calldata)
        public
        view
        virtual
        override
        returns (address[] memory, uint8);

    // ============ Public Functions ============

    /**
     * @notice Requires that the chosen ISM has verified '_message'
     * @param _metadata ABI encoded module metadata (see OptimisticIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    // function preVerify(bytes calldata _metadata, bytes calldata _message)
    //     public
    //     view
    //     returns (bool)
    // {
    //     address memory _ism = preVerifyIsm(_message);
    //     if (!OptimisticIsmMetadata.hasMetadata(_metadata)) continue;
    //     IInterchainSecurityModule _ism = IInterchainSecurityModule(_ism);
    //     require(
    //         _ism.verify(
    //             AggregationIsmMetadata.metadataAt(_metadata, i),
    //             _message
    //         ),
    //         "!verify"
    //     );
    //     return true;
    // }

    /**
     * @notice Requires that m-of-n watchers sign '_message'
     * and agree on fraudulence of '_message'
     * @param _metadata ABI encoded module metadata (see OptimisticIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        require(!_verifyWatcherSignatures(_metadata, _message), "!fraud");
        return true;
    }

    /**
     * @notice Verifies that a quorum of watchers signed
     * the given message.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyWatcherSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        (address[] memory _watchers, uint8 _threshold) = watchersAndThreshold(
            _message
        );
        require(_threshold > 0, "No threshold present for fraud message");
        // Update the digest calculation to include only _message
        bytes32 _digest = keccak256(_message);

        uint256 _watcherCount = _watchers.length;
        uint256 _watcherIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            console.logBytes(OptimisticIsmMetadata.signatureAt(_metadata, i));
            address _signer = ECDSA.recover(
                _digest,
                OptimisticIsmMetadata.signatureAt(_metadata, i)
            );
            // Loop through remaining validators until we find a match
            while (
                _watcherIndex < _watcherCount &&
                _signer != _watchers[_watcherIndex]
            ) {
                ++_watcherIndex;
            }
            // Return false if we never found a match
            if (_watcherIndex >= _watcherCount) {
                return false;
            }
            ++_watcherIndex;
        }
        return true;
    }
}
