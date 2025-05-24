// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

/**
 * @title Hyperlane ERC721 Token Collateral that wraps an existing ERC721 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC721Collateral is TokenRouter {
    IERC721 public immutable wrappedToken;

    /**
     * @notice Constructor
     * @param erc721 Address of the token to keep as collateral
     */
    constructor(address erc721, address _mailbox) TokenRouter(_mailbox) {
        wrappedToken = IERC721(erc721);
    }

    /**
     * @notice Initializes the Hyperlane router
     * @param _hook The post-dispatch hook contract.
       @param _interchainSecurityModule The interchain security module contract.
       @param _owner The this contract.
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public virtual initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function ownerOf(uint256 _tokenId) external view returns (address) {
        return wrappedToken.ownerOf(_tokenId);
    }

    /**
     * @dev Returns the balance of `_account` for `wrappedToken`.
     * @inheritdoc TokenRouter
     */
    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return wrappedToken.balanceOf(_account);
    }

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(
        uint256 _tokenId
    ) internal virtual override returns (bytes memory) {
        // safeTransferFrom not used here because recipient is this contract
        wrappedToken.transferFrom(msg.sender, address(this), _tokenId);
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
        wrappedToken.safeTransferFrom(address(this), _recipient, _tokenId);
    }
}
