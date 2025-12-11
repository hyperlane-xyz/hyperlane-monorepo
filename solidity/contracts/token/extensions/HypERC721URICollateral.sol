// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC721Collateral} from "../HypERC721Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

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

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to fetch the URI and pass it to the token message.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _tokenId
    ) public payable override returns (bytes32 messageId) {
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge({
            _destination: _destination,
            _recipient: _recipient,
            _amount: _tokenId,
            _msgValue: msg.value
        });

        string memory _tokenURI = IERC721MetadataUpgradeable(
            address(wrappedToken)
        ).tokenURI(_tokenId);

        bytes memory _tokenMessage = TokenMessage.format({
            _recipient: _recipient,
            _amount: _tokenId,
            _metadata: bytes(_tokenURI)
        });

        // 3. Emit the SentTransferRemote event and 4. dispatch the message
        return
            _emitAndDispatch({
                _destination: _destination,
                _recipient: _recipient,
                _amount: _tokenId,
                _messageDispatchValue: remainingNativeValue,
                _tokenMessage: _tokenMessage
            });
    }
}
