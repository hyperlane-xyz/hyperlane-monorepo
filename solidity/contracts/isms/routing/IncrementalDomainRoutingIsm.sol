// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title IncrementalDomainRoutingIsm
 * @notice A DomainRoutingIsm variant that prevents overwriting existing domain configurations
 * @dev Reverts when attempting to set a domain that already exists. Use remove() first to update.
 */
contract IncrementalDomainRoutingIsm is DomainRoutingIsm {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using Strings for uint32;

    /**
     * @notice Sets the ISM to be used for the specified origin domain
     * @dev Reverts if the domain already exists in the routing table
     * @param _domain The origin domain
     * @param _module The ISM to use to verify messages
     */
    function _set(uint32 _domain, address _module) internal override {
        require(
            !_modules.contains(_domain),
            string.concat("Domain already exists: ", _domain.toString())
        );
        super._set(_domain, _module);
    }
}
