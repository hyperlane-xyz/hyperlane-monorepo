// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// TODO: add ownable
contract OPL2ToL1ProveWithdrawalIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using Message for bytes;

    // CCIP-read gateways URLs
    string[] urls;
    // mailbox on L1
    IMailbox mailbox;
    // the OP Portal contract on L1
    IOptimismPortal immutable opPortal;
    // true when the withdrawal relative to the
    // given message id has been proven
    mapping(bytes32 => bool) public provenWithdrawals;

    // OP sepolia portal @ 0x16Fc5058F25648194471939df75CF27A2fdC48BC
    // OP mainnet portal @ 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed
    constructor(string[] memory _urls, address _opPortal, address _mailbox) {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
        mailbox = IMailbox(_mailbox);
        opPortal = IOptimismPortal(_opPortal);
    }

    function setUrls(string[] memory _urls) external {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        // FIXME: revert if message is not proven
        // otherwise relayer will continue to loop
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("getWithdrawalProof(bytes)", _message), // bytes callData,
            OPL2ToL1ProveWithdrawalIsm.process.selector, // bytes4 callbackFunction,
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

        // bytes32 withdrawalMessageId = _getMessageIdFromWithdrawalTxData(
        //     _tx.data
        // );

        // NOTE: we expect the transferRemote() return value
        // as message id
        // provenWithdrawals[withdrawalMessageId] = true;

        opPortal.proveWithdrawalTransaction(
            _tx,
            _disputeGameIndex,
            _outputRootProof,
            _withdrawalProof
        );
        // return provenWithdrawals[keccak256(_message.body())];

        return true;
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    /**
     * @dev no-op handle
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable {}

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
