// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../../token/libs/TokenRouter.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * @notice Prove and finalize a OP stack withdrawal on L1
 * @dev Proving and finalizing had been merged into a single
 * ISM because OP Stack expects the prover and the finalizer to
 * be the same caller
 */
contract OPL2ToL1CcipReadIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using Message for bytes;
    using TypeCasts for address;

    // CCIP-read gateways URLs
    string[] public urls;
    // mailbox on L1
    IMailbox mailbox;
    // the OP Portal contract on L1
    IOptimismPortal immutable opPortal;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        uint256 indexed value,
        bytes message
    );

    constructor(string[] memory _urls, address _opPortal, address _mailbox) {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
        mailbox = IMailbox(_mailbox);
        opPortal = IOptimismPortal(_opPortal);
    }

    // TODO: remove
    function setUrls(string[] memory _urls) external {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("getOffchainData(bytes)", _message),
            OPL2ToL1CcipReadIsm.process.selector,
            _message
        );
    }

    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        if (_areWeMessageRecipient(_message)) {
            _proveWithdrawal(_metadata);
        } else {
            _finalizeWithdrawal(_metadata);
        }

        return true;
    }

    /**
     * @dev no-op handle
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _messageBody
    ) external payable {
        emit ReceivedMessage(_origin, _sender, msg.value, _messageBody);
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    function _areWeMessageRecipient(
        bytes calldata _message
    ) internal view returns (bool) {
        return _message.recipient() == address(this).addressToBytes32();
    }

    function _proveWithdrawal(bytes calldata _metadata) internal {
        (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        ) = abi.decode(
                _metadata,
                (
                    IOptimismPortal.WithdrawalTransaction,
                    uint256,
                    IOptimismPortal.OutputRootProof,
                    bytes[]
                )
            );

        opPortal.proveWithdrawalTransaction(
            _tx,
            _disputeGameIndex,
            _outputRootProof,
            _withdrawalProof
        );
    }

    function _finalizeWithdrawal(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal {
        bytes32 withdrawalHash = abi.decode(
            TokenMessage.metadata(_message.body()),
            (bytes32)
        );

        // NOTE: this lets the Mailbox deliver the message
        // even if the someone else call first portal.finalizeWithdrawalTransaction()
        if (IOptimismPortal.finalizedWithdrawals(withdrawalHash)) {
            return;
        }

        (IOptimismPortal.WithdrawalTransaction memory _tx, , , ) = abi.decode(
            _metadata,
            (
                IOptimismPortal.WithdrawalTransaction,
                uint256,
                IOptimismPortal.OutputRootProof,
                bytes[]
            )
        );

        opPortal.finalizeWithdrawalTransaction(_tx);
    }
}
