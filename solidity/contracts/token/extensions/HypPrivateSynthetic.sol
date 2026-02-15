// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title HypPrivateSynthetic
 * @notice Privacy-enhanced synthetic token transfers
 * @dev Mints tokens on receive from Aleo, burns on deposit to Aleo
 * @author Hyperlane
 */
contract HypPrivateSynthetic is HypPrivate, ERC20Upgradeable {
    uint8 private immutable _decimals;

    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_scale, _mailbox, _aleoPrivacyHub, _aleoDomain) {
        _decimals = __decimals;
    }

    /**
     * @notice Initializes the Hyperlane router and ERC20 metadata
     * @param _name Token name
     * @param _symbol Token symbol
     * @param _totalSupply Initial total supply (minted to owner)
     * @param _hook The post-dispatch hook contract
     * @param _interchainSecurityModule The interchain security module contract
     * @param _owner The owner of this contract
     */
    function initialize(
        string memory _name,
        string memory _symbol,
        uint256 _totalSupply,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __ERC20_init(_name, _symbol);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        _HypPrivate_initialize();
        if (_totalSupply > 0) {
            _mint(_owner, _totalSupply);
        }
    }

    /**
     * @notice Returns address(this) to indicate synthetic token
     */
    function token() public view override returns (address) {
        return address(this);
    }

    /**
     * @notice Returns the number of decimals used for the token
     */
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Burn tokens from sender on deposit
     */
    function _transferFromSender(uint256 _amount) internal override {
        require(msg.value == 0, "HypPrivateSynthetic: no native token");
        _burn(msg.sender, _amount);
    }

    /**
     * @notice Mint tokens to recipient on receive
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        _mint(_recipient, _amount);
    }

    /**
     * @dev Override msg.value to return 0 for ERC20 transfers
     */
    function _msgValue() internal pure override returns (uint256) {
        return 0;
    }
}
