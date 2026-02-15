// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title HypPrivateNative
 * @notice Privacy-enhanced native token transfers (ETH, MATIC, AVAX, etc.)
 * @dev Locks native tokens on deposit, releases on receive
 * @author Hyperlane
 */
contract HypPrivateNative is HypPrivate {
    using Address for address payable;

    constructor(
        uint256 _scale,
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_scale, _mailbox, _aleoPrivacyHub, _aleoDomain) {}

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

    /**
     * @notice Returns address(0) to indicate native token
     */
    function token() public pure override returns (address) {
        return address(0); // Native token
    }

    /**
     * @notice Deposit native tokens for private transfer via Aleo
     * @dev Amount derived from msg.value (minus gas payment)
     * @param secret User-generated 32-byte secret (must be kept secure)
     * @param finalDestination Destination chain domain ID
     * @param recipient Final recipient address (bytes32)
     * @return messageId Hyperlane message ID
     * @return commitment Generated commitment hash
     */
    function depositPrivate(
        bytes32 secret,
        uint32 finalDestination,
        bytes32 recipient
    ) public payable returns (bytes32 messageId, bytes32 commitment) {
        // Calculate gas payment first
        uint256 gasPayment = _gasPayment(aleoDomain);

        // Derive amount from msg.value (minus gas payment)
        require(msg.value > gasPayment, "HypPrivateNative: insufficient value");
        uint256 amount = msg.value - gasPayment;

        // Call parent with explicit amount
        return
            super.depositPrivate(secret, finalDestination, recipient, amount);
    }

    /**
     * @notice Accept native token from sender
     * @dev Validates msg.value matches expected amount + gas payment
     */
    function _transferFromSender(uint256 _amount) internal override {
        uint256 gasPayment = _gasPayment(aleoDomain);
        require(
            msg.value == _amount + gasPayment,
            "HypPrivateNative: value mismatch"
        );
    }

    /**
     * @notice Send native token to recipient
     * @dev Uses OpenZeppelin's safe transfer
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        payable(_recipient).sendValue(_amount);
    }

    /**
     * @notice Receive native tokens for collateral
     * @dev Allows contract to receive native tokens for liquidity
     */
    receive() external payable {}
}
