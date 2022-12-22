// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721} from "../HypERC721.sol";

import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

/**
 * @title Hyperlane ERC721 Token that extends ERC721URIStorage with remote transfer and URI relay functionality.
 * @author Abacus Works
 */
contract HypERC721URIStorage is HypERC721, ERC721URIStorageUpgradeable {
    /**
     * @notice Constructor
     * @param gasAmount Amount of destination gas to be paid for processing
     */
    constructor(uint256 gasAmount) HypERC721(gasAmount) {}

    /**
     * @return _tokenURI The URI of `_tokenId`.
     * @inheritdoc HypERC721
     */
    function _transferFromSender(uint256 _tokenId)
        internal
        override
        returns (bytes memory _tokenURI)
    {
        _tokenURI = bytes(tokenURI(_tokenId)); // requires minted
        HypERC721._transferFromSender(_tokenId);
    }

    /**
     * @dev Sets the URI for `_tokenId` to `_tokenURI`.
     * @inheritdoc HypERC721
     */
    function _transferTo(
        address _recipient,
        uint256 _tokenId,
        bytes calldata _tokenURI
    ) internal override {
        HypERC721._transferTo(_recipient, _tokenId, _tokenURI);
        _setTokenURI(_tokenId, string(_tokenURI)); // requires minted
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721Upgradeable, ERC721URIStorageUpgradeable)
        returns (string memory)
    {
        return ERC721URIStorageUpgradeable.tokenURI(tokenId);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721EnumerableUpgradeable, ERC721Upgradeable) {
        ERC721EnumerableUpgradeable._beforeTokenTransfer(
            from,
            to,
            tokenId,
            batchSize
        );
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721EnumerableUpgradeable, ERC721Upgradeable)
        returns (bool)
    {
        return ERC721EnumerableUpgradeable.supportsInterface(interfaceId);
    }

    function _burn(uint256 tokenId)
        internal
        override(ERC721URIStorageUpgradeable, ERC721Upgradeable)
    {
        ERC721URIStorageUpgradeable._burn(tokenId);
    }
}
