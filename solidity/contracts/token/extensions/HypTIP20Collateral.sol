// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITIP20} from "../interfaces/ITIP20.sol";
import {ITIP403Registry} from "../interfaces/ITIP403Registry.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title HypTIP20Collateral
 * @notice Collateral Hyperlane Token Router for existing TIP-20 tokens with memo and TIP-403 support.
 * @dev Extends TokenRouter to enable cross-chain TIP-20 transfers with payment references preserved.
 * Supports optional TIP-403 pre-flight checks for compliance controls.
 * For creating NEW TIP-20 tokens via factory, use HypTIP20 instead.
 */
contract HypTIP20Collateral is TokenRouter {
    using TypeCasts for bytes32;
    using TokenMessage for bytes;
    using SafeERC20 for IERC20;

    ITIP20 public immutable wrappedToken;
    ITIP403Registry public immutable tip403Registry;

    /**
     * @notice Emitted when a remote transfer with memo is sent.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens sent.
     * @param memo The memo associated with the transfer.
     */
    event SentTransferRemoteWithMemo(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 memo
    );

    /**
     * @notice Emitted when a remote transfer with memo is received.
     * @param origin The identifier of the origin chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens received.
     * @param memo The memo associated with the transfer.
     */
    event ReceivedTransferRemoteWithMemo(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 memo
    );

    constructor(
        address _tip20Token,
        address _tip403Registry,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        require(
            Address.isContract(_tip20Token),
            "HypTIP20Collateral: invalid token"
        );
        wrappedToken = ITIP20(_tip20Token);
        tip403Registry = ITIP403Registry(_tip403Registry);
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ============ TokenRouter overrides ============

    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to perform optional TIP-403 pre-flight check and burn tokens on outbound transfer.
     */
    function _transferFromSender(uint256 _amount) internal override {
        // TIP-403 pre-flight check for better error messages.
        // Note: The token itself also enforces TIP-403 via transferAuthorized modifier,
        // but checking here provides clearer revert reasons and saves gas on failure.
        _validateTransferPolicy(msg.sender);

        // Transfer amount to address(this) using SafeERC20 for compatibility
        IERC20(address(wrappedToken)).safeTransferFrom(
            msg.sender,
            address(this),
            _amount
        );

        // Burn amount from address(this) balance
        wrappedToken.burn(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     * Note: Memo handling is done in _handle() to access metadata.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken.mint(_recipient, _amount);
    }

    // ============ Public API ============

    /**
     * @notice Transfers tokens to a recipient on a remote chain with a memo.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount of tokens to send.
     * @param _memo The memo to associate with the transfer.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemoteWithMemo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _memo
    ) public payable returns (bytes32 messageId) {
        address _feeToken = feeToken();

        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        // Note: _calculateFeesAndCharge internally calls _transferFromSender which handles
        // TIP-403 validation and token burn
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount,
            msg.value
        );

        // 2. Scale the amount for the message
        uint256 scaledAmount = _outboundAmount(_amount);

        // 3. Prepare the token message with the recipient, amount, and memo
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            scaledAmount,
            abi.encodePacked(_memo)
        );

        // 4. Emit the SentTransferRemoteWithMemo event
        emit SentTransferRemoteWithMemo(
            _destination,
            _recipient,
            scaledAmount,
            _memo
        );

        // 5. Dispatch the message with fee-token metadata
        return
            _Router_dispatch(
                _destination,
                remainingNativeValue,
                _tokenMessage,
                _generateHookMetadata(_destination, _feeToken),
                address(hook)
            );
    }

    /**
     * @notice Transfers tokens to a recipient on a remote chain without a memo.
     * @dev Delegates to transferRemoteWithMemo with an empty memo.
     * @param _destination The identifier of the destination chain.
     * @param _recipient The address of the recipient on the destination chain.
     * @param _amount The amount of tokens to send.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        return
            transferRemoteWithMemo(
                _destination,
                _recipient,
                _amount,
                bytes32(0)
            );
    }

    /**
     * @notice Handles the incoming transfer message with memo support.
     * @param _origin The identifier of the origin chain.
     * @param _message The message data containing recipient, amount, and optional memo.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();
        bytes calldata metadata = _message.metadata();

        // effects
        emit ReceivedTransferRemote(_origin, recipient, amount);

        // interactions - extract memo if present
        address recipientAddr = recipient.bytes32ToAddress();
        uint256 localAmount = _inboundAmount(amount);

        if (metadata.length >= 32) {
            bytes32 memo = bytes32(metadata[0:32]);
            wrappedToken.mintWithMemo(recipientAddr, localAmount, memo);
            emit ReceivedTransferRemoteWithMemo(
                _origin,
                recipient,
                localAmount,
                memo
            );
        } else {
            wrappedToken.mint(recipientAddr, localAmount);
        }
    }

    // ============ Internal helpers ============

    /**
     * @dev Validates transfer policy via TIP-403 registry if configured.
     * Policy ID semantics: 0 = reject all, 1 = allow all, 2+ = custom policy
     * @param sender The address initiating the transfer.
     */
    function _validateTransferPolicy(address sender) internal view {
        if (address(tip403Registry) == address(0)) return;

        uint64 policyId = wrappedToken.transferPolicyId();

        // Policy 0 = reject all transfers
        require(policyId != 0, "TIP403: transfers disabled");

        // Policy 1 = allow all, no check needed
        // Policy 2+ = query the registry
        if (policyId >= 2) {
            require(
                tip403Registry.isAuthorized(policyId, sender),
                "TIP403: sender not authorized"
            );
        }
    }
}
