// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import "../Outbox.sol";

contract TestOutbox is Outbox {
    constructor(uint32 _localDomain) Outbox(_localDomain) {} // solhint-disable-line no-empty-blocks

    function destinationAndNonce(uint32 _destination, uint32 _nonce)
        external
        pure
        returns (uint64)
    {
        return _destinationAndNonce(_destination, _nonce);
    }

    /**
     * @notice Set the ValidatorManager
     * @param _validatorManager Address of the ValidatorManager
     */
    function testSetValidatorManager(address _validatorManager) external {
        validatorManager = _validatorManager;
    }
}
