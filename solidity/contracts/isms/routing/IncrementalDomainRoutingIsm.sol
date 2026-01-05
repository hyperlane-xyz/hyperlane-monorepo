// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title IncrementalDomainRoutingIsm
 * @notice A DomainRoutingIsm variant that enforces append-only domain configurations
 * @dev Reverts when attempting to set a domain that already exists or remove any domain.
 */
contract IncrementalDomainRoutingIsm is DomainRoutingIsm {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using Strings for uint32;

    /**
     * @inheritdoc DomainRoutingIsm
     * @dev Reverts if the domain already exists in the routing table
     */
    function _set(uint32 _domain, address _module) internal override {
        require(
            !_modules.contains(_domain),
            string.concat(
                "IncrementalDomainRoutingIsm: Domain already exists: ",
                _domain.toString()
            )
        );
        super._set(_domain, _module);
    }

    /**
     * @inheritdoc DomainRoutingIsm
     * @dev Always reverts - IncrementalDomainRoutingIsm does not support removal
     */
    function _remove(uint32 /*_domain*/) internal override {
        revert("IncrementalDomainRoutingIsm: removal not supported");
    }
}
