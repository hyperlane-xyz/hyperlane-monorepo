// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721Collateral} from "../HypERC721Collateral.sol";

import {IERC721MetadataUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/IERC721MetadataUpgradeable.sol";

/**
 * @title Hyperlane ERC721 Token Collateral that wraps an existing ERC721 with remote transfer and URI relay functionality.
 * @author Abacus Works
 */
contract HypERC721URICollateral is HypERC721Collateral {
    constructor(address erc721) HypERC721Collateral(erc721) {}

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from `msg.sender` to this contract.
     * @return The URI of `_tokenId` on `wrappedToken`.
     * @inheritdoc HypERC721Collateral
     */
    function _transferFromSender(uint256 _tokenId)
        internal
        override
        returns (bytes memory)
    {
        HypERC721Collateral._transferFromSender(_tokenId);
        return
            bytes(IERC721MetadataUpgradeable(wrappedToken).tokenURI(_tokenId));
    }
}
