// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../../token/libs/TokenRouter.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {OPL2ToL1Withdrawal} from "../../libs/OPL2ToL1Withdrawal.sol";
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

    // Raised when the withdrawal hash of the
    // given transaction does not match the one
    // included in the message
    error InvalidWithdrawalHash(bytes32 invalidHash, bytes32 correctHash);

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

    /// @dev called by the relayer when the off-chain data is ready
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
            _proveWithdrawal(_metadata, _message);
        } else {
            _finalizeWithdrawal(_metadata, _message);
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

    /// @dev We check the withdrawal hash here in order to prevent someone
    /// DDoS-ing the transfer execution by providing a message relative to a legit withdrawal X
    /// and a valid proof relative to withdrawal Y
    function _proveWithdrawal(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal {
        bytes32 withdrawalHash = abi.decode(_message.body(), (bytes32));

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

        bytes32 untrustedWithdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(
            _tx
        );
        if (withdrawalHash != untrustedWithdrawalHash) {
            revert InvalidWithdrawalHash(
                untrustedWithdrawalHash,
                withdrawalHash
            );
        }

        opPortal.proveWithdrawalTransaction(
            _tx,
            _disputeGameIndex,
            _outputRootProof,
            _withdrawalProof
        );
    }

    /// @dev No need to do the same withdrawal hash check here as done
    /// in _proveWithdrawal() since there's no risk of DoS here: checking
    /// if the withdrawal has been finalized already is enough
    function _finalizeWithdrawal(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) internal {
        IOptimismPortal.WithdrawalTransaction memory _tx = abi.decode(
            _metadata,
            (IOptimismPortal.WithdrawalTransaction)
        );

        bytes32 withdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(_tx);

        if (!opPortal.finalizedWithdrawals(withdrawalHash)) {
            opPortal.finalizeWithdrawalTransaction(_tx);
        }
    }

    /// @dev Copied from Hashing.sol of Optimism
    function _hashWithdrawal(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _tx.nonce,
                    _tx.sender,
                    _tx.target,
                    _tx.value,
                    _tx.gasLimit,
                    _tx.data
                )
            );
    }
}
