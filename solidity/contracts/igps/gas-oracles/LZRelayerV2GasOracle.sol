// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IGasOracle} from "../../../interfaces/IGasOracle.sol";
import {ILZRelayerV2} from "../../../interfaces/ILZRelayerV2.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice A gas oracle that uses data found on the LayerZero RelayerV2 contract.
 */
contract LZRelayerV2GasOracle is IGasOracle, Ownable {
    // ============ Public Storage ============

    /// @notice A mapping of Hyperlane domains to LayerZero domains.
    mapping(uint32 => uint16) public hyperlaneToLzDomain;

    /// @notice The address of the LZ Relayer contract.
    ILZRelayerV2 public lzRelayer;

    // ============ Events ============

    /**
     * @notice Emitted when the stored `lzRelayer` is set.
     * @param lzRelayer The new value of the stored `lzRelayer`.
     */
    event LzRelayerSet(address lzRelayer);

    /**
     * @notice Emitted when an entry in the `hyperlaneToLzDomain` mapping is set.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param lzDomain The corresponding lzDomain.
     */
    event HyperlaneToLzDomainSet(uint32 hyperlaneDomain, uint16 lzDomain);

    /// @notice A Hyperlane domain and its corresponding lzDomain.
    struct DomainConfig {
        uint32 hyperlaneDomain;
        uint16 lzDomain;
    }

    // ============ Constructor ============

    constructor(address _lzRelayer) {
        _setLzRelayer(_lzRelayer);
    }

    // ============ External Functions ============

    /**
     * @notice Gets the token exchange rate and gas price from the `lzRelayer` contract
     * for a given destination domain.
     * @param _destinationDomain The destination domain.
     * @return tokenExchangeRate The exchange rate of the remote native token quoted in the local native token.
     * @return gasPrice The gas price on the remote chain.
     */
    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        external
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        uint16 _lzDomain = hyperlaneToLzDomain[_destinationDomain];
        require(_lzDomain != uint16(0), "!lz domain");

        (uint128 _dstPriceRatio, uint128 _dstGasPriceInWei) = lzRelayer
            .dstPriceLookup(_lzDomain);
        return (_dstPriceRatio, _dstGasPriceInWei);
    }

    /**
     * @notice Sets the `lzRelayer`.
     * @param _lzRelayer The new `lzRelayer` address.
     */
    function setLzRelayer(address _lzRelayer) external onlyOwner {
        _setLzRelayer(_lzRelayer);
    }

    /**
     * @notice Sets the Hyperlane domain to LZ domain in the `hyperlaneToLzDomain` mapping
     * for each provided DomainConfig.
     * @param _configs Domain configs to update the `hyperlaneToLzDomain` mapping with.
     */
    function setHyperlaneToLzDomains(DomainConfig[] memory _configs)
        external
        onlyOwner
    {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            DomainConfig memory _config = _configs[i];
            _setHyperlaneToLzDomain(_config.hyperlaneDomain, _config.lzDomain);
        }
    }

    // ============ Internal functions ============

    /**
     * @notice Sets the `lzRelayer`.
     * @param _lzRelayer The new `lzRelayer` address.
     */
    function _setLzRelayer(address _lzRelayer) internal {
        lzRelayer = ILZRelayerV2(_lzRelayer);
        emit LzRelayerSet(_lzRelayer);
    }

    /**
     * @notice Sets the Hyperlane domain's LZ domain in the `hyperlaneToLzDomain` mapping.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _lzDomain The corresponding LZ domain.
     */
    function _setHyperlaneToLzDomain(uint32 _hyperlaneDomain, uint16 _lzDomain)
        internal
    {
        hyperlaneToLzDomain[_hyperlaneDomain] = _lzDomain;
        emit HyperlaneToLzDomainSet(_hyperlaneDomain, _lzDomain);
    }
}
