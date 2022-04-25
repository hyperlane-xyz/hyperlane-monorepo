// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainGasPaymaster} from "./IInterchainGasPaymaster.sol";
import {IOutbox} from "./IOutbox.sol";

interface IAbacusConnectionManager {
    function outbox() external view returns (IOutbox);

    function interchainGasPaymaster()
        external
        view
        returns (IInterchainGasPaymaster);

    function isInbox(address _inbox) external view returns (bool);

    function localDomain() external view returns (uint32);
}
