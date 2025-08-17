// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {IOFTCore} from "./interfaces/IOFTCore.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";

contract TokenBridgeOft is HypERC20Collateral {
    struct Domain {
        uint32 hyperlane;
        uint16 lzEid;
        bytes dstVault;
        bytes adapterParams;
    }

    mapping(uint32 => Domain) internal _domainMap;

    event DomainAdded(uint32 indexed hyperlaneDomain, uint16 lzEid);

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        HypERC20Collateral.initialize(_hook, _interchainSecurityModule, _owner);
    }

    function addDomain(
        uint32 _hyperlaneDomain,
        uint16 _lzEid,
        bytes calldata _dstVault,
        bytes calldata _adapterParams
    ) public onlyOwner {
        _domainMap[_hyperlaneDomain] = Domain({
            hyperlane: _hyperlaneDomain,
            lzEid: _lzEid,
            dstVault: _dstVault,
            adapterParams: _adapterParams
        });
        emit DomainAdded(_hyperlaneDomain, _lzEid);
    }

    function addDomains(Domain[] calldata domains) external onlyOwner {
        for (uint256 i = 0; i < domains.length; i++) {
            addDomain(
                domains[i].hyperlane,
                domains[i].lzEid,
                domains[i].dstVault,
                domains[i].adapterParams
            );
        }
    }

    function hyperlaneDomainToLayerZeroEid(
        uint32 _hyperlaneDomain
    ) public view returns (uint16) {
        Domain memory d = _domainMap[_hyperlaneDomain];
        require(d.hyperlane == _hyperlaneDomain, "LZ EID not configured");
        return d.lzEid;
    }

    function quoteTransferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](2);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destinationDomain, _recipient, _amount)
        });
        quotes[1] = Quote({token: address(wrappedToken), amount: _amount});
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal override returns (bytes32 messageId) {
        bytes32 enrolledRouter = _mustHaveRemoteRouter(_destination);
        require(_recipient == enrolledRouter, "Invalid recipient");

        HypERC20Collateral._transferFromSender(_amount);

        uint256 outbound = _outboundAmount(_amount);
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            outbound,
            bytes("")
        );

        messageId = _Router_dispatch(
            _destination,
            _value,
            _tokenMessage,
            _hookMetadata,
            _hook
        );

        Domain memory d = _domainMap[_destination];
        require(d.hyperlane == _destination, "EID not configured");

        IOFTCore(address(wrappedToken)).sendFrom{value: 0}(
            address(this),
            d.lzEid,
            d.dstVault,
            outbound,
            d.adapterParams
        );

        emit SentTransferRemote(_destination, _recipient, outbound);
    }

    function _transferTo(address, uint256, bytes calldata) internal override {}
}
