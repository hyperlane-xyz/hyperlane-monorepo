// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {MultisigValidatorManager} from "../validator-manager/MultisigValidatorManager.sol";

/**
 * This contract exists to test MultisigValidatorManager.sol, which is abstract
 * and cannot be deployed directly.
 */
contract TestMultisigValidatorManager is MultisigValidatorManager {
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _domain,
        address[] memory _validators,
        uint256 _threshold
    ) MultisigValidatorManager(_domain, _validators, _threshold) {}

    /**
     * @notice Hash of domain concatenated with "ABACUS".
     * @dev This is a public getter of _domainHash to test with.
     * @param _domain The domain to hash.
     */
    function getDomainHash(uint32 _domain) external pure returns (bytes32) {
        return _domainHash(_domain);
    }
}
