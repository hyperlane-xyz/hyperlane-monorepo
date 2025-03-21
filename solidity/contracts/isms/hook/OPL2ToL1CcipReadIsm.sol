// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

contract OPL2ToL1CcipReadIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using Message for bytes;
    using TypeCasts for address;

    // CCIP-read gateways URLs
    string[] urls;
    // mailbox on L1
    IMailbox mailbox;
    // the OP Portal contract on L1
    IOptimismPortal immutable opPortal;

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
        bytes memory ccipReadCallData = _areWeMessageRecipient(_message)
            ? abi.encodeWithSignature("getWithdrawalProof(bytes)", _message)
            : abi.encodeWithSignature(
                "getFinalizeWithdrawalTx(bytes)",
                _message
            );

        revert OffchainLookup(
            address(this),
            urls,
            ccipReadCallData,
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
        bytes calldata _message
    ) external payable {}

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
                abi.decode(_metadata, (bytes)), // NOTE: due to the chainlink's ccip-server ABI data type conversions
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

    function _finalizeWithdrawal(bytes calldata _metadata) internal {
        IOptimismPortal.WithdrawalTransaction memory _tx = abi.decode(
            abi.decode(_metadata, (bytes)), // NOTE: due to the chainlink's ccip-server ABI data type conversions
            (IOptimismPortal.WithdrawalTransaction)
        );

        opPortal.finalizeWithdrawalTransaction(_tx);
    }
}
