// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// TODO: add ownable
contract OPL2ToL1FinalizeWithdrawalIsm is AbstractCcipReadIsm {
    using Message for bytes;

    string[] public urls;
    IMailbox public immutable mailbox;
    IOptimismPortal public immutable opPortal;

    mapping(bytes32 => bool) public finalizedWithdrawals;

    constructor(string[] memory _urls, address _opPortal, address _mailbox) {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
        opPortal = IOptimismPortal(_opPortal);
        mailbox = IMailbox(_mailbox);
    }

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
            abi.encodeWithSignature("getFinalizeWithdrawalTx(bytes)", _message),
            OPL2ToL1FinalizeWithdrawalIsm.process.selector,
            _message
        );
    }

    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        IOptimismPortal.WithdrawalTransaction memory _tx = abi.decode(
            _metadata,
            (IOptimismPortal.WithdrawalTransaction)
        );

        bytes32 messageId = _getMessageIdFromWithdrawalTxData(_tx.data);

        // NOTE: we expect the message id to be included
        // into the L2 bridge withdrawal data
        finalizedWithdrawals[messageId] = true;

        opPortal.finalizeWithdrawalTransaction(_tx);

        mailbox.process(_metadata, _message);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        require(msg.sender == address(mailbox), "invalid msg.sender");

        return finalizedWithdrawals[_message.id()];
    }

    // TODO: factor out
    function _getMessageIdFromWithdrawalTxData(
        bytes memory txData
    ) internal pure returns (bytes32) {
        (
            uint256 _destination,
            address _source,
            address _nonce,
            uint256 _sender,
            uint256 _target,
            bytes memory _message
        ) = abi.decode(
                _removeFirst4Bytes(txData),
                (uint256, address, address, uint256, uint256, bytes)
            );

        (address from, address to, uint256 amount, bytes memory extraData) = abi
            .decode(
                _removeFirst4Bytes(_message),
                (address, address, uint256, bytes)
            );

        return abi.decode(extraData, (bytes32));
    }

    // TODO: factor out
    function _removeFirst4Bytes(
        bytes memory data
    ) internal pure returns (bytes memory) {
        require(data.length >= 4, "Data must be at least 4 bytes long");

        bytes memory result = new bytes(data.length - 4);

        assembly {
            let src := add(data, 0x24) // Skip the length (0x20) and first 4 bytes (0x04)
            let dest := add(result, 0x20) // Destination starts at 0x20 (after length prefix)
            let len := sub(mload(data), 4) // Adjust length

            mstore(result, len) // Store new length
            for {
                let i := 0
            } lt(i, len) {
                i := add(i, 32)
            } {
                mstore(add(dest, i), mload(add(src, i)))
            }
        }

        return result;
    }
}
