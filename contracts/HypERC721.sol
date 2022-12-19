// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";

/**
 * @title Hyperlane ERC721 Token Router that extends ERC721 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC721 is ERC721EnumerableUpgradeable, TokenRouter {
    /**
     * @notice Initializes the Hyperlane router, ERC721 metadata, and mints initial supply to deployer.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _mintAmount The amount of NFTs to mint to `msg.sender`.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        uint256 _mintAmount,
        string memory _name,
        string memory _symbol
    ) external initializer {
        // transfers ownership to `msg.sender`
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster
        );

        __ERC721_init(_name, _symbol);
        for (uint256 i = 0; i < _mintAmount; i++) {
            _mint(msg.sender, i);
        }
    }

    /**
     * @dev Asserts `msg.sender` is owner and burns `_tokenId`.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _tokenId)
        internal
        virtual
        override
        returns (bytes memory)
    {
        require(ownerOf(_tokenId) == msg.sender, "!owner");
        _burn(_tokenId);
        return bytes(""); // no metadata
    }

    /**
     * @dev Mints `_tokenId` to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _tokenId,
        bytes calldata // no metadata
    ) internal virtual override {
        _mint(_recipient, _tokenId);
    }
}
