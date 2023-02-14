// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IAggregationIsm} from "../../interfaces/IAggregationIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {AggregationIsmMetadata} from "../libs/AggregationIsmMetadata.sol";
import {EnumerableMOfNSet} from "../libs/EnumerableMOfNSet.sol";
import {OwnableMOfNSet} from "../libs/OwnableMOfNSet.sol";

/**
 * @title AggregationIsm
 * @notice Manages per-domain m-of-n ISM sets that are used to verify
 * interchain messages.
 */
contract AggregationIsm is IAggregationIsm, OwnableMOfNSet {
    // ============ Libraries ============

    using Message for bytes;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.AGGREGATION);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() OwnableMOfNSet() {}

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
        uint8 _verified = 0;
        uint8 _count = AggregationIsmMetadata.count(_metadata);
        for (uint8 i = 0; i < _count; i++) {
            if (!AggregationIsmMetadata.hasMetadata(_metadata, i)) continue;
            IInterchainSecurityModule _ism = AggregationIsmMetadata.ismAt(
                _metadata,
                i
            );
            require(
                _ism.verify(
                    AggregationIsmMetadata.metadataAt(_metadata, i),
                    _message
                ),
                "!verify"
            );
            _verified += 1;
        }
        // Ensures the ISM set encoded in the metadata matches
        // what we've stored on chain.
        // NB: An empty ISM set in `_metadata` will result in a
        // non-zero computed commitment, and this check will fail
        // as the commitment in storage will be zero.
        require(
            setMatches(
                _message.origin(),
                _verified,
                AggregationIsmMetadata.ismAddresses(_metadata)
            ),
            "!matches"
        );
        return true;
    }

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return isms The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function ismsAndThreshold(bytes calldata _message)
        external
        view
        returns (address[] memory, uint8)
    {
        uint32 _origin = _message.origin();
        return valuesAndThreshold(_origin);
    }
}
