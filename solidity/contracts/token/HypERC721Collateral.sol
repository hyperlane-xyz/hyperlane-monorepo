// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TokenRouter} from "./libs/TokenRouter.sol";
import {ERC721Collateral} from "./libs/TokenCollateral.sol";

// ============ External Imports ============
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Hyperlane ERC721 Token Collateral that wraps an existing ERC721 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC721Collateral is TokenRouter {
    using ERC721Collateral for IERC721;

    IERC721 public immutable wrappedToken;

    /**
     * @notice Constructor
     * @param erc721 Address of the token to keep as collateral
     */
    constructor(address erc721, address _mailbox) TokenRouter(1, _mailbox) {
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

    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _feeRecipientAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view override returns (uint256) {
        // cannot charge fees in token() for NFTs
        return 0;
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _externalFeeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view override returns (uint256) {
        // cannot charge fees in token() for NFTs
        return 0;
    }

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from `msg.sender` to this contract.
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _tokenId) internal override {
        wrappedToken._transferFromSender(_tokenId);
    }

    /**
     * @dev Transfers `_tokenId` of `wrappedToken` from this contract to `_recipient`.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _tokenId
    ) internal override {
        wrappedToken._transferTo(_recipient, _tokenId);
    }
}
