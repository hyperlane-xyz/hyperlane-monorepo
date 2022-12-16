// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Hyperlane ERC721 Token Collateral that wraps an existing ERC721 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC721Collateral is TokenRouter {
    address public immutable wrappedToken;

    constructor(address erc721) {
        wrappedToken = erc721;
    }

    /**
     * @notice Initializes the Hyperlane router.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule
        );
    }

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _tokenId)
        internal
        virtual
        override
        returns (bytes memory)
    {
        IERC721(wrappedToken).transferFrom(msg.sender, address(this), _tokenId);
        return bytes(""); // no metadata
    }

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _tokenId,
        bytes calldata // no metadata
    ) internal override {
        IERC721(wrappedToken).transferFrom(address(this), _recipient, _tokenId);
    }
}
