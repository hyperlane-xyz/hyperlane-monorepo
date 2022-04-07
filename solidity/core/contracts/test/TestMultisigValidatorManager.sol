// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
pragma abicoder v2;

import {MultisigValidatorManager} from "../validator-manager/MultisigValidatorManager.sol";

/**
 * This contract exists to test MultisigValidatorManager.sol, which is abstract
 * and cannot be deployed directly.
 */
contract TestMultisigValidatorManager is MultisigValidatorManager {
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _outboxDomain,
        address[] memory _validatorSet,
        uint256 _quorumThreshold
    )
        MultisigValidatorManager(_outboxDomain, _validatorSet, _quorumThreshold)
    {}
}
