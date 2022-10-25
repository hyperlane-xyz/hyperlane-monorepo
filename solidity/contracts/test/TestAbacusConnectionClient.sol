// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {IOutbox} from "../../interfaces/IOutbox.sol";

import "../AbacusConnectionClient.sol";

contract TestAbacusConnectionClient is AbacusConnectionClient {
    function initialize(address _abacusConnectionManager) external initializer {
        __AbacusConnectionClient_initialize(_abacusConnectionManager);
    }

    function outbox() external view returns (IOutbox) {
        return _outbox();
    }

    function isInbox(address _potentialInbox) external view returns (bool) {
        return _isInbox(_potentialInbox);
    }

    function localDomain() external view returns (uint32) {
        return _localDomain();
    }
}
