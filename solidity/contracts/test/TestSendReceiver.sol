// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {ISpecifiesInterchainSecurityModule, IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

contract TestSendReceiver is
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using TypeCasts for address;

    uint256 public constant HANDLE_GAS_AMOUNT = 50_000;
    IInterchainSecurityModule private _ism;

    event Handled(bytes32 blockHash);

    function dispatchToSelf(
        IMailbox _mailbox,
        uint32 _destinationDomain,
        bytes calldata _messageBody,
        IPostDispatchHook hook
    ) public payable {
        dispatchToSelf(
            _mailbox,
            _destinationDomain,
            _messageBody,
            hook,
            IInterchainSecurityModule(address(0))
        );
    }

    function dispatchToSelf(
        IMailbox _mailbox,
        uint32 _destinationDomain,
        bytes calldata _messageBody,
        IPostDispatchHook hook,
        IInterchainSecurityModule ism
    ) public payable {
        bytes memory hookMetadata = StandardHookMetadata.formatMetadata(
            HANDLE_GAS_AMOUNT,
            msg.sender
        );
        _ism = ism;
        // TODO: handle topping up?
        _mailbox.dispatch{value: msg.value}(
            _destinationDomain,
            address(this).addressToBytes32(),
            _messageBody,
            hookMetadata,
            hook
        );
    }

    function interchainSecurityModule()
        external
        view
        returns (IInterchainSecurityModule)
    {
        return _ism;
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external payable override {
        bytes32 blockHash = previousBlockHash();
        bool isBlockHashEndIn0 = uint256(blockHash) % 16 == 0;
        require(!isBlockHashEndIn0, "block hash ends in 0");
        emit Handled(blockHash);
    }

    function previousBlockHash() internal view returns (bytes32) {
        return blockhash(block.number - 1);
    }
}
