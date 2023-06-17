// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../Router.sol";

import {AggregatorV3Interface} from "../interfaces/chainlink/AggregatorV3Interface.sol";

import {TypeCasts} from "../libs/TypeCasts.sol";

contract ChainlinkAggregator is Router, AggregatorV3Interface {
    address public priceFeed;

    // Used for s_oracles[a].role, where a is an address, to track the purpose
    // of the address, or to indicate that the address is unset.
    enum Role {
        // No oracle role has been set for address a
        Unset,
        // Signing address for the s_oracles[a].index'th oracle. I.e., report
        // signatures from this oracle should ecrecover back to address a.
        Signer,
        // Transmission address for the s_oracles[a].index'th oracle. I.e., if a
        // report is received by OffchainAggregator.transmit in which msg.sender is
        // a, it is attributed to the s_oracles[a].index'th oracle.
        Transmitter
    }

    struct Oracle {
        uint8 index; // Index of oracle in s_signers/s_transmitters
        Role role; // Role of the address which mapped to this struct
    }

    struct HotVars {
        // Provides 128 bits of security against 2nd pre-image attacks, but only
        // 64 bits against collisions. This is acceptable, since a malicious owner has
        // easier way of messing up the protocol than to find hash collisions.
        bytes16 latestConfigDigest;
        uint40 latestEpochAndRound; // 32 most sig bits for epoch, 8 least sig bits for round
        // Current bound assumed on number of faulty/dishonest oracles participating
        // in the protocol, this value is referred to as f in the design
        uint8 threshold;
        // Chainlink Aggregators expose a roundId to consumers. The offchain reporting
        // protocol does not use this id anywhere. We increment it whenever a new
        // transmission is made to provide callers with contiguous ids for successive
        // reports.
        uint32 latestAggregatorRoundId;
    }
    HotVars internal s_hotVars;

    struct ReportData {
        HotVars hotVars; // Only read from storage once
        bytes observers; // ith element is the index of the ith observer
        int192[] observations; // ith element is the ith observation
        bytes vs; // jth element is the v component of the jth signature
        bytes32 rawReportContext;
    }

    // Transmission records the median answer from the transmit transaction at
    // time timestamp
    struct Transmission {
        int192 answer; // 192 bits ought to be enough for anyone
        uint64 timestamp;
    }
    mapping(uint32 => Transmission) /* aggregator round ID */
        internal s_transmissions;

    event PriceFeedSet(address indexed feed);

    /**
     * @notice Initializes the Router contract with Hyperlane core contracts and the address of the interchain security module.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner,
        address _priceFeed,
        uint8 _decimals
    ) external initializer onlyOwner {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
        priceFeed = _priceFeed;
        emit PriceFeedSet(_priceFeed);

        decimals = _decimals;
    }

    // Public functions

    function setPriceFeed(address _feed) external onlyOwner {
        priceFeed = _feed;
        emit PriceFeedSet(_feed);
    }

    /*
     * v2 Aggregator interface
     */

    /**
     * @notice median from the most recent report
     */
    function latestAnswer() public view virtual returns (int256) {
        return s_transmissions[s_hotVars.latestAggregatorRoundId].answer;
    }

    /**
     * @notice timestamp of block in which last report was transmitted
     */
    function latestTimestamp() public view virtual returns (uint256) {
        return s_transmissions[s_hotVars.latestAggregatorRoundId].timestamp;
    }

    /**
     * @notice Aggregator round (NOT OCR round) in which last report was transmitted
     */
    function latestRound() public view virtual returns (uint256) {
        return s_hotVars.latestAggregatorRoundId;
    }

    /**
     * @notice median of report from given aggregator round (NOT OCR round)
     * @param _roundId the aggregator round of the target report
     */
    function getAnswer(uint256 _roundId) public view virtual returns (int256) {
        if (_roundId > 0xFFFFFFFF) {
            return 0;
        }
        return s_transmissions[uint32(_roundId)].answer;
    }

    /**
     * @notice timestamp of block in which report from given aggregator round was transmitted
     * @param _roundId aggregator round (NOT OCR round) of target report
     */
    function getTimestamp(uint256 _roundId)
        public
        view
        virtual
        returns (uint256)
    {
        if (_roundId > 0xFFFFFFFF) {
            return 0;
        }
        return s_transmissions[uint32(_roundId)].timestamp;
    }

    /*
     * v3 Aggregator interface
     */

    string private constant V3_NO_DATA_ERROR = "No data present";

    /**
     * @return answers are stored in fixed-point format, with this many digits of precision
     */
    uint8 public override decimals;

    /**
     * @notice aggregator contract version
     */
    uint256 public constant override version = 4;

    string internal s_description;

    /**
     * @notice human-readable description of observable this contract is reporting on
     */
    function description()
        public
        view
        virtual
        override
        returns (string memory)
    {
        return s_description;
    }

    /**
     * @notice details for the given aggregator round
     * @param _roundId target aggregator round (NOT OCR round). Must fit in uint32
     * @return roundId _roundId
     * @return answer median of report from given _roundId
     * @return startedAt timestamp of block in which report from given _roundId was transmitted
     * @return updatedAt timestamp of block in which report from given _roundId was transmitted
     * @return answeredInRound _roundId
     */
    function getRoundData(uint80 _roundId)
        public
        view
        virtual
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        require(_roundId <= 0xFFFFFFFF, V3_NO_DATA_ERROR);
        Transmission memory transmission = s_transmissions[uint32(_roundId)];
        return (
            _roundId,
            transmission.answer,
            transmission.timestamp,
            transmission.timestamp,
            _roundId
        );
    }

    /**
     * @notice aggregator details for the most recently transmitted report
     * @return roundId aggregator round of latest report (NOT OCR round)
     * @return answer median of latest report
     * @return startedAt timestamp of block containing latest report
     * @return updatedAt timestamp of block containing latest report
     * @return answeredInRound aggregator round of latest report
     */
    function latestRoundData()
        public
        view
        virtual
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        roundId = s_hotVars.latestAggregatorRoundId;

        // Skipped for compatability with existing FluxAggregator in which latestRoundData never reverts.
        // require(roundId != 0, V3_NO_DATA_ERROR);

        Transmission memory transmission = s_transmissions[uint32(roundId)];
        return (
            roundId,
            transmission.answer,
            transmission.timestamp,
            transmission.timestamp,
            roundId
        );
    }

    // Handles a message from an enrolled remote LiquidityLayerRouter
    function _handle(
        uint32 _origin,
        bytes32, // _sender, unused
        bytes calldata _message
    ) internal override {
        ReportData memory r;

        bytes32 rawObservers;
        (r.rawReportContext, rawObservers, r.observations) = abi.decode(
            _message,
            (bytes32, bytes32, int192[])
        );

        uint40 epochAndRound = uint40(uint256(r.rawReportContext));

        // Copy observer identities in bytes32 rawObservers to bytes r.observers
        r.observers = new bytes(r.observations.length);
        for (uint8 i = 0; i < r.observations.length; i++) {
            uint8 observerIdx = uint8(rawObservers[i]);
            r.observers[i] = rawObservers[i];
        }

        // record epochAndRound here, so that we don't have to carry the local
        // variable in transmit. The change is reverted if something fails later.
        r.hotVars.latestEpochAndRound = epochAndRound;

        // Check the report contents, and record the result
        for (uint256 i = 0; i < r.observations.length - 1; i++) {
            bool inOrder = r.observations[i] <= r.observations[i + 1];
            require(inOrder, "observations not sorted");
        }

        int192 median = r.observations[r.observations.length / 2];
        // require(
        //     minAnswer <= median && median <= maxAnswer,
        //     "median is out of min-max range"
        // );
        r.hotVars.latestAggregatorRoundId++;
        s_transmissions[r.hotVars.latestAggregatorRoundId] = Transmission(
            median,
            uint64(block.timestamp)
        );

        emit NewTransmission(
            r.hotVars.latestAggregatorRoundId,
            median,
            msg.sender,
            r.observations,
            r.observers,
            r.rawReportContext
        );
        // Emit these for backwards compatability with offchain consumers
        // that only support legacy events
        emit NewRound(
            r.hotVars.latestAggregatorRoundId,
            address(0x0), // use zero address since we don't have anybody "starting" the round here
            block.timestamp
        );
        emit AnswerUpdated(
            median,
            r.hotVars.latestAggregatorRoundId,
            block.timestamp
        );

        s_hotVars = r.hotVars;
    }
}
