// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HypPrivateCollateral
 * @notice Privacy-enhanced ERC20 transfers with movable collateral
 * @dev Locks ERC20 tokens on deposit, releases on receive
 *      Supports direct rebalancing between chains (bypasses Aleo for speed)
 * @author Hyperlane
 */
contract HypPrivateCollateral is HypPrivate {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Message type identifier for rebalancing messages
    bytes1 private constant REBALANCE_MESSAGE_TYPE = 0x01;

    // ============ Immutables ============

    /// @notice The ERC20 token being bridged
    IERC20 public immutable wrappedToken;

    // ============ Events ============

    /**
     * @notice Emitted when collateral is sent for rebalancing
     * @param destination Domain ID where collateral was sent
     * @param amount Amount of collateral sent
     */
    event CollateralSent(uint32 indexed destination, uint256 amount);

    /**
     * @notice Emitted when collateral is received for rebalancing
     * @param origin Domain ID where collateral came from
     * @param amount Amount of collateral received
     */
    event CollateralReceived(uint32 indexed origin, uint256 amount);

    // ============ Constructor ============

    constructor(
        address _wrappedToken,
        uint256 _scale,
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_scale, _mailbox, _aleoPrivacyHub, _aleoDomain) {
        require(
            _wrappedToken != address(0),
            "HypPrivateCollateral: zero token"
        );
        wrappedToken = IERC20(_wrappedToken);
    }

    /**
     * @notice Initializes the Hyperlane router
     * @param _hook The post-dispatch hook contract
     * @param _interchainSecurityModule The interchain security module contract
     * @param _owner The owner of this contract
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _HypPrivate_initialize();
    }

    // ============ Token Operations ============

    /**
     * @notice Returns the wrapped ERC20 token address
     */
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @notice Pull ERC20 tokens from sender
     */
    function _transferFromSender(uint256 _amount) internal override {
        require(msg.value == 0, "HypPrivateCollateral: no native token");
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    /**
     * @notice Send ERC20 tokens to recipient
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    /**
     * @dev Override msg.value to return 0 for ERC20 transfers
     */
    function _msgValue() internal pure override returns (uint256) {
        return 0;
    }

    // ============ Rebalancing Functions ============

    /**
     * @notice Move collateral to another chain for rebalancing
     * @dev Sends directly to destination (bypasses Aleo for immediate liquidity)
     *      This is NOT private - use only for operational rebalancing
     * @param destination Destination domain ID
     * @param amount Amount of collateral to move
     * @return messageId Hyperlane message ID
     */
    function transferRemoteCollateral(
        uint32 destination,
        uint256 amount
    ) external onlyOwner returns (bytes32 messageId) {
        require(
            destination != aleoDomain,
            "HypPrivateCollateral: cannot rebalance to Aleo"
        );

        bytes32 destinationRouter = remoteRouters[destination];
        require(
            destinationRouter != bytes32(0),
            "HypPrivateCollateral: router not enrolled"
        );

        // Check sufficient balance
        uint256 balance = wrappedToken.balanceOf(address(this));
        require(
            balance >= amount,
            "HypPrivateCollateral: insufficient collateral"
        );

        // Encode rebalance message (type = 0x01)
        bytes memory messageBody = abi.encodePacked(
            REBALANCE_MESSAGE_TYPE, // 1 byte
            amount // 32 bytes
        );

        // Dispatch directly to destination (bypass Aleo)
        messageId = mailbox.dispatch{value: _gasPayment(destination)}(
            destination,
            destinationRouter,
            messageBody
        );

        emit CollateralSent(destination, amount);
    }

    /**
     * @notice Handle messages - supports both private transfers and rebalancing
     * @dev Differentiates message type by first byte
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        // Check if this is a rebalance message
        if (_message.length > 0 && _message[0] == REBALANCE_MESSAGE_TYPE) {
            // Rebalance message - must be from enrolled router
            require(
                remoteRouters[_origin] == _sender,
                "HypPrivateCollateral: router not enrolled"
            );

            // Decode amount (skip first byte)
            uint256 amount = abi.decode(_message[1:], (uint256));

            emit CollateralReceived(_origin, amount);
        } else {
            // Private transfer - must be from Aleo hub
            super._handle(_origin, _sender, _message);
        }
    }

    // ============ Query Functions ============

    /**
     * @notice Get total collateral balance held by this contract
     * @return Current balance of wrapped token
     */
    function collateralBalance() external view returns (uint256) {
        return wrappedToken.balanceOf(address(this));
    }
}
