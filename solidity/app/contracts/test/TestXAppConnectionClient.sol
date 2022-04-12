// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {IInterchainGasPaymaster} from "@abacus-network/core/interfaces/IInterchainGasPaymaster.sol";
import {IOutbox} from "@abacus-network/core/interfaces/IOutbox.sol";

import "../XAppConnectionClient.sol";

contract TestXAppConnectionClient is XAppConnectionClient {
    function initialize(address _xAppConnectionManager) external {
        __XAppConnectionClient_initialize(_xAppConnectionManager);
    }

    function outbox() external view returns (IOutbox) {
        return _outbox();
    }

    function interchainGasPaymaster()
        external
        view
        returns (IInterchainGasPaymaster)
    {
        return _interchainGasPaymaster();
    }

    function isInbox(address _potentialInbox) external view returns (bool) {
        return _isInbox(_potentialInbox);
    }

    function localDomain() external view returns (uint32) {
        return _localDomain();
    }
}
