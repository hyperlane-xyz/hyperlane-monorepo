// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../../interfaces/IInterchainSecurityModule.sol";
import {IAggregationIsm} from "../../../interfaces/IAggregationIsm.sol";
import {Message} from "../../libs/Message.sol";
import {AggregationIsmMetadata} from "../../libs/AggregationIsmMetadata.sol";
import {MerkleLib} from "../../libs/Merkle.sol";

/**
 * @title AggregationIsm
 * @notice Manages per-domain m-of-n ISM sets that are used to verify
 * interchain messages.
 */
abstract contract AbstractAggregationIsm is IAggregationIsm {
    // ============ Libraries ============

    using Message for bytes;
    using AggregationIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MULTISIG);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return isms The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function ismsAndThreshold(bytes calldata _message)
        public
        view
        virtual
        returns (address[] memory, uint8);

    // ============ Public Functions ============

    /**
     * @notice Requires that m-of-n ISMs verify the provided interchain message.
     * @param _metadata ABI encoded module metadata (see AggregationIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        (address[] memory _isms, uint8 _threshold) = ismsAndThreshold(_message);
        uint256 _count = _isms.length;
        for (uint8 i = 0; i < _count; i++) {
            if (!AggregationIsmMetadata.hasMetadata(_metadata, i)) continue;
            IInterchainSecurityModule _ism = IInterchainSecurityModule(
                _isms[i]
            );
            require(
                _ism.verify(
                    AggregationIsmMetadata.metadataAt(_metadata, i),
                    _message
                ),
                "!verify"
            );
            _threshold -= 1;
        }
        require(_threshold == 0, "!threshold");
        return true;
    }
}
