// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721Collateral} from "../HypERC721Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

import {IERC721MetadataUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/IERC721MetadataUpgradeable.sol";

/**
 * @title Hyperlane ERC721 Token Collateral that wraps an existing ERC721 with remote transfer and URI relay functionality.
 * @author Abacus Works
 */
contract HypERC721URICollateral is HypERC721Collateral {
    // solhint-disable-next-line no-empty-blocks
    constructor(
        address erc721,
        address _mailbox
    ) HypERC721Collateral(erc721, _mailbox) {}

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _tokenId
    ) internal override returns (uint256 dispatchValue, bytes memory message) {
        HypERC721Collateral._transferFromSender(_tokenId);
        dispatchValue = msg.value;

        string memory _tokenURI = IERC721MetadataUpgradeable(
            address(wrappedToken)
        ).tokenURI(_tokenId);
        message = TokenMessage.format(_recipient, _tokenId, bytes(_tokenURI));
    }
}
