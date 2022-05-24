// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import "../Outbox.sol";

contract TestOutbox is Outbox {
    constructor(uint32 _localDomain) Outbox(_localDomain) {} // solhint-disable-line no-empty-blocks

    /**
     * @notice Set the validator manager
     * @param _validatorManager Address of the validator manager
     */
    function testSetValidatorManager(address _validatorManager) external {
        validatorManager = _validatorManager;
    }
}
