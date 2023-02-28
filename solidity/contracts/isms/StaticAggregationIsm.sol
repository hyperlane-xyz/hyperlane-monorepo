// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IAggregationIsm} from "../../interfaces/IAggregationIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {StaticAggregationIsmMetadata} from "../libs/StaticAggregationIsmMetadata.sol";
import {StaticMOfNAddressSet} from "./StaticMOfNAddressSet.sol";

// Imagine you want to run a president/congress model
// With approach 1:
//   Deploy 1 president StaticMultisigIsm per remote chain
//   Collect them all in a RoutingIsm
//   Aggregate the President RoutingIsm with the congress default ISM
//
// With approach 2:
//   Deploy 1 President MultisigIsm, configure it for each remote chain
//   Aggregate the DefaultIsm with the President MultisigIsm, configured for each remote chain
//
// Approach 2 requires more config?
// Not clear...
contract StaticAggregationIsm is StaticMOfNAddressSet, IAggregationIsm {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.AGGREGATION);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(address[] memory _isms, uint8 threshold)
        StaticMOfNAddressSet(_isms, threshold)
    {}

    // ============ Public Functions ============

    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        uint256 _verified = 0;
        for (uint8 i = 0; i < _numValues; i++) {
            if (!StaticAggregationIsmMetadata.hasMetadata(_metadata, i))
                continue;
            IInterchainSecurityModule _ism = IInterchainSecurityModule(
                valueAt(i)
            );
            require(
                _ism.verify(
                    StaticAggregationIsmMetadata.metadataAt(_metadata, i),
                    _message
                ),
                "!verify"
            );
            _verified += 1;
            if (_verified == _threshold) {
                return true;
            }
        }
        return false;
    }

    function ismsAndThreshold(bytes calldata)
        public
        view
        returns (address[] memory, uint8)
    {
        return (values(), _threshold);
    }
}
