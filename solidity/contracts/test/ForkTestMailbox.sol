// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Mailbox} from "../Mailbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

interface IRelayer {
    function addInboundMessage(bytes calldata message) external;
}

contract ForkTestMailbox is Mailbox {
    using TypeCasts for bytes32;

    IRelayer internal immutable relayer;

    constructor(uint32 _localDomain, address _relayer) Mailbox(_localDomain) {
        relayer = IRelayer(_relayer);
    }

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        bytes calldata metadata,
        IPostDispatchHook hook
    ) public payable override returns (bytes32 id) {
        bytes memory message = _buildMessage(
            destinationDomain,
            recipientAddress,
            messageBody
        );
        id = super.dispatch(
            destinationDomain,
            recipientAddress,
            messageBody,
            metadata,
            hook
        );
        relayer.addInboundMessage(message);
    }
}
