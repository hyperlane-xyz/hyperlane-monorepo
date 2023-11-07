// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721} from "../HypERC721.sol";

import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Hyperlane ERC721 Token that extends ERC721URIStorage with remote transfer and URI relay functionality.
 * @author Abacus Works
 */
contract HypERC721URIStorage is HypERC721, ERC721URIStorage {
    constructor(
        string memory _name,
        string memory _symbol,
        address _mailbox
    ) HypERC721(_name, _symbol, _mailbox) {}

    function balanceOf(
        address account
    ) public view override(HypERC721, ERC721, IERC721) returns (uint256) {
        return HypERC721.balanceOf(account);
    }

    /**
     * @return _tokenURI The URI of `_tokenId`.
     * @inheritdoc HypERC721
     */
    function _transferFromSender(
        uint256 _tokenId
    ) internal override returns (bytes memory _tokenURI) {
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

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return ERC721URIStorage.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721URIStorage) returns (bool) {
        return ERC721URIStorage.supportsInterface(interfaceId);
    }

    function _burn(
        uint256 tokenId
    ) internal override(ERC721, ERC721URIStorage) {
        ERC721URIStorage._burn(tokenId);
    }
}
