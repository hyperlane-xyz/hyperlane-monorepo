// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {IERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";

/**
 * @title Hyperlane ERC721 Token Router that extends ERC721 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC721 is ERC721EnumerableUpgradeable, TokenRouter {
    constructor(address _mailbox) TokenRouter(1, _mailbox) {}

    /**
     * @notice Initializes the Hyperlane router, ERC721 metadata, and mints initial supply to deployer.
     * @param _mintAmount The amount of NFTs to mint to `msg.sender`.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     * @param _hook The post-dispatch hook contract.
       @param _interchainSecurityModule The interchain security module contract.
       @param _owner The this contract.
     */
    function initialize(
        uint256 _mintAmount,
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: _interchainSecurityModule,
            _owner: _owner
        });
        __ERC721_init(_name, _symbol);
        for (uint256 i = 0; i < _mintAmount; i++) {
            _safeMint(msg.sender, i);
        }
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(this);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev NFTs cannot have a fee recipient
     */
    function feeRecipient() public view override returns (address) {
        return address(0);
    }

    /**
     * @dev Asserts `msg.sender` is owner and burns `_tokenId`.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _tokenId) internal override {
        require(ownerOf(_tokenId) == msg.sender, "!owner");
        _burn(_tokenId);
    }

    /**
     * @dev Mints `_tokenId` to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _tokenId
    ) internal override {
        _safeMint(_recipient, _tokenId);
    }
}
