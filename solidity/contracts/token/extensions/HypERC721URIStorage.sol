// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721} from "../HypERC721.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";

/**
 * @title Hyperlane ERC721 Token that extends ERC721URIStorage with remote transfer and URI relay functionality.
 * @author Abacus Works
 */
contract HypERC721URIStorage is HypERC721, ERC721URIStorageUpgradeable {
    using TokenMessage for bytes;
    using TypeCasts for bytes32;

    constructor(address _mailbox) HypERC721(_mailbox) {}

    function balanceOf(
        address account
    )
        public
        view
        override(HypERC721, ERC721Upgradeable, IERC721Upgradeable)
        returns (uint256)
    {
        return HypERC721.balanceOf(account);
    }

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _tokenId
    ) internal override returns (uint256 dispatchValue, bytes memory message) {
        string memory _tokenURI = tokenURI(_tokenId); // requires minted

        HypERC721._transferFromSender(_tokenId);

        dispatchValue = msg.value;

        message = TokenMessage.format(
            _recipient,
            _tokenId,
            abi.encodePacked(_tokenURI)
        );
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 tokenId = _message.tokenId();

        emit ReceivedTransferRemote(_origin, recipient, tokenId);

        HypERC721._transferTo(recipient.bytes32ToAddress(), tokenId);
        _setTokenURI(tokenId, string(_message.metadata()));
    }

    function tokenURI(
        uint256 tokenId
    )
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

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(ERC721EnumerableUpgradeable, ERC721URIStorageUpgradeable)
        returns (bool)
    {
        return ERC721EnumerableUpgradeable.supportsInterface(interfaceId);
    }

    function _burn(
        uint256 tokenId
    ) internal override(ERC721URIStorageUpgradeable, ERC721Upgradeable) {
        ERC721URIStorageUpgradeable._burn(tokenId);
    }
}
