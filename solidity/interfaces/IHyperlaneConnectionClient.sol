// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {IInterchainGasPaymaster} from "./IInterchainGasPaymaster.sol";
import {ISpecifiesInterchainSecurityModule} from "./IInterchainSecurityModule.sol";
import {IMailbox} from "./IMailbox.sol";

interface IHyperlaneConnectionClient is ISpecifiesInterchainSecurityModule {
    function mailbox() external view returns (IMailbox);

    function interchainGasPaymaster()
        external
        view
        returns (IInterchainGasPaymaster);

    function setMailbox(address) external;

    function setInterchainGasPaymaster(address) external;

    function setInterchainSecurityModule(address) external;
}
