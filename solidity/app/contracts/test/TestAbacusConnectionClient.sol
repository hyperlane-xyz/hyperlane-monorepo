// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../AbacusConnectionClient.sol";

contract TestAbacusConnectionClient is AbacusConnectionClient {
    constructor(address _abacusConnectionManager) {
        _setAbacusConnectionManager(_abacusConnectionManager);
    }

    function outbox() external view returns (address) {
        return address(_outbox());
    }

    function isInbox(address _potentialInbox) external view returns (bool) {
        return _isInbox(_potentialInbox);
    }

    function localDomain() external view returns (uint32) {
        return _localDomain();
    }
}
