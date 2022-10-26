// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

interface IMessageRecipient {
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external;
}

interface IHasInterchainSecurityModule {
    function interchainSecurityModule()
        external
        view
        returns (IInterchainSecurityModule);
}
