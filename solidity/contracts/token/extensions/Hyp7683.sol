// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {Test, console} from "forge-std/Test.sol";

import {TypeCasts} from "../../libs/TypeCasts.sol";

import {TokenMessage} from "../libs/TokenMessage.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Common FastTokenRouter functionality for ERC20 Tokens with remote transfer support.
 * @author Abacus Works
 */
contract Hyp7683 is HypERC20Collateral, ERC20Upgradeable {
    using SafeERC20 for IERC20;

    using TypeCasts for bytes32;
    using TokenMessage for bytes;

    uint256 public nonce;
    uint256 public fastFee;

    // maps `fastTransferId` to the filler address.
    mapping(bytes32 => address) filledFastTransfers;

    event FilledFastTransfer(
        uint32 indexed origin,
        uint256 indexed nonce,
        address recipient,
        uint256 amount,
        uint256 fastFee,
        address filler
    );

    constructor(
        address erc20,
        address _mailbox,
        uint256 _fastFee
    ) HypERC20Collateral(erc20, _mailbox) {
        fastFee = _fastFee;
    }

    /**
     * @notice Initializes the Hyperlane router, ERC20 metadata, and mints initial supply to deployer.
     * @param _totalSupply The initial supply of the token.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     */
    function initialize(
        uint256 _totalSupply,
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        // Initialize ERC20 metadata
        __ERC20_init(_name, _symbol);
        _mint(msg.sender, _totalSupply);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function balanceOf(
        address _account
    )
        public
        view
        override(ERC20Upgradeable, HypERC20Collateral)
        returns (uint256)
    {
        return ERC20Upgradeable.balanceOf(_account);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc HypERC20Collateral
     */
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        super._transferFromSender(_amount);
        uint256 _nextNonce = nonce + 1;
        nonce = _nextNonce;
        return abi.encode(fastFee, _nextNonce);
    }

    /**
     * @dev delegates transfer logic to `_transferTo`.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();
        bytes calldata metadata = _message.metadata();
        _transferTo(recipient.bytes32ToAddress(), amount, _origin, metadata);
        emit ReceivedTransferRemote(_origin, recipient, amount);
    }

    /**
     * @dev Transfers `_amount` of token to `_recipient`/`fastFiller` who provided LP.
     * @dev Called by `handle` after message decoding.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        uint32 _origin,
        bytes calldata _metadata
    ) internal virtual {
        if (_metadata.length == 0) {
            // console.log("no metadata");
            // is not a fast fill transfer, so just transfer to recipient.
            // TODO: pull from LP
            wrappedToken.safeTransfer(_recipient, _amount);
            return;
        }

        // decode metadata to extract `_fastFee` and `_nonce`.
        (uint256 _fastFee, uint256 _nonce) = abi.decode(
            _metadata,
            (uint256, uint256)
        );

        address _fillerAddress = filledFastTransfers[
            _getFastTransfersKey(_origin, _nonce, _amount, _fastFee, _recipient)
        ];

        if (_fillerAddress != address(0)) {
            // Was fast filled, transfer synthetic to filler
            _mint(_fillerAddress, _amount);
            return;
        }

        // Was not fast filled, transfer to recipient
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev generates the key for storing the filler address of fast transfers.
     */
    function _getFastTransfersKey(
        uint32 _origin,
        uint256 _nonce,
        uint256 _amount,
        uint256 _fastFee,
        address _recipient
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(_origin, _nonce, _amount, _fastFee, _recipient)
            );
    }

    function _fastTransferTo(address _recipient, uint256 _amount) internal {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev allows an external user to full an unfilled fast transfer order.
     * @param _recipient The recipient of the wrapped token on base chain.
     * @param _amount The amount of wrapped tokens that is being bridged.
     * @param _nonce Id assigned on the remote chain to uniquely identify the transfer.
     */
    function fillFastTransfer(
        address _recipient,
        uint256 _amount,
        uint32 _origin,
        uint256 _nonce
    ) external virtual {
        bytes32 filledFastTransfersKey = _getFastTransfersKey(
            _origin,
            _nonce,
            _amount,
            fastFee,
            _recipient
        );
        require(
            filledFastTransfers[filledFastTransfersKey] == address(0),
            "request already filled"
        );

        filledFastTransfers[filledFastTransfersKey] = msg.sender;

        wrappedToken.safeTransferFrom(
            msg.sender,
            _recipient,
            _amount - fastFee
        );

        emit FilledFastTransfer(
            _origin,
            _nonce,
            _recipient,
            _amount,
            fastFee,
            msg.sender
        );
    }

    // Settlement transferRemotes

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemoteSettle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId
    ) external payable virtual returns (bytes32 messageId) {
        return
            _transferRemoteSettle(
                _destination,
                _recipient,
                _amountOrId,
                msg.value
            );
    }

    /**
     * @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain with a specified hook
     * @dev Delegates transfer logic to `_transferFromSender` implementation.
     * @dev The metadata is the token metadata, and is DIFFERENT than the hook metadata.
     * @dev Emits `SentTransferRemote` event on the origin chain.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
     * @param _hookMetadata The metadata passed into the hook
     * @param _hook The post dispatch hook to be called by the Mailbox
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemoteSettle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        bytes calldata _hookMetadata,
        address _hook
    ) external payable virtual returns (bytes32 messageId) {
        return
            _transferRemoteSettle(
                _destination,
                _recipient,
                _amountOrId,
                msg.value,
                _hookMetadata,
                _hook
            );
    }

    function _transferRemoteSettle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _value
    ) internal returns (bytes32 messageId) {
        return
            _transferRemoteSettle(
                _destination,
                _recipient,
                _amountOrId,
                _value,
                _GasRouter_hookMetadata(_destination),
                address(hook)
            );
    }

    function _transferRemoteSettle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual returns (bytes32 messageId) {
        // Here we are burning the synthetic token the filler has
        bytes memory _tokenMetadata = _transferFromSenderSettle(_amountOrId);
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _amountOrId,
            _tokenMetadata
        );

        messageId = _Router_dispatch(
            _destination,
            _value,
            _tokenMessage,
            _hookMetadata,
            _hook
        );

        emit SentTransferRemote(_destination, _recipient, _amountOrId);
    }

    function _transferFromSenderSettle(
        uint256 _amount
    ) internal virtual returns (bytes memory) {
        // Just burn the synthetic token
        _burn(msg.sender, _amount);
        // No nonce needed for settlement
        // No fee desired for settlement
        return abi.encode(0, 0);
    }

    // get claim on origin collateral
    // release collateral
    // allow specification of fees
    // support permit2
    // pair this with LP pool
    // allow price improvement
}
