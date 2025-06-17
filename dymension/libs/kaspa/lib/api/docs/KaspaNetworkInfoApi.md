# \KaspaNetworkInfoApi

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_blockdag_info_blockdag_get**](KaspaNetworkInfoApi.md#get_blockdag_info_blockdag_get) | **GET** /info/blockdag | Get Blockdag
[**get_blockreward_info_blockreward_get**](KaspaNetworkInfoApi.md#get_blockreward_info_blockreward_get) | **GET** /info/blockreward | Get Blockreward
[**get_circulating_coins_info_coinsupply_circulating_get**](KaspaNetworkInfoApi.md#get_circulating_coins_info_coinsupply_circulating_get) | **GET** /info/coinsupply/circulating | Get Circulating Coins
[**get_coinsupply_info_coinsupply_get**](KaspaNetworkInfoApi.md#get_coinsupply_info_coinsupply_get) | **GET** /info/coinsupply | Get Coinsupply
[**get_fee_estimate_info_fee_estimate_get**](KaspaNetworkInfoApi.md#get_fee_estimate_info_fee_estimate_get) | **GET** /info/fee-estimate | Get Fee Estimate
[**get_halving_info_halving_get**](KaspaNetworkInfoApi.md#get_halving_info_halving_get) | **GET** /info/halving | Get Halving
[**get_hashrate_history_info_hashrate_history_get**](KaspaNetworkInfoApi.md#get_hashrate_history_info_hashrate_history_get) | **GET** /info/hashrate/history | Get Hashrate History
[**get_hashrate_info_hashrate_get**](KaspaNetworkInfoApi.md#get_hashrate_info_hashrate_get) | **GET** /info/hashrate | Get Hashrate
[**get_kaspad_info_info_kaspad_get**](KaspaNetworkInfoApi.md#get_kaspad_info_info_kaspad_get) | **GET** /info/kaspad | Get Kaspad Info
[**get_marketcap_info_marketcap_get**](KaspaNetworkInfoApi.md#get_marketcap_info_marketcap_get) | **GET** /info/marketcap | Get Marketcap
[**get_max_hashrate_info_hashrate_max_get**](KaspaNetworkInfoApi.md#get_max_hashrate_info_hashrate_max_get) | **GET** /info/hashrate/max | Get Max Hashrate
[**get_network_info_network_get**](KaspaNetworkInfoApi.md#get_network_info_network_get) | **GET** /info/network | Get Network
[**get_price_info_price_get**](KaspaNetworkInfoApi.md#get_price_info_price_get) | **GET** /info/price | Get Price
[**get_total_coins_info_coinsupply_total_get**](KaspaNetworkInfoApi.md#get_total_coins_info_coinsupply_total_get) | **GET** /info/coinsupply/total | Get Total Coins
[**get_virtual_selected_parent_blue_score_info_virtual_chain_blue_score_get**](KaspaNetworkInfoApi.md#get_virtual_selected_parent_blue_score_info_virtual_chain_blue_score_get) | **GET** /info/virtual-chain-blue-score | Get Virtual Selected Parent Blue Score
[**health_state_info_health_get**](KaspaNetworkInfoApi.md#health_state_info_health_get) | **GET** /info/health | Health State



## get_blockdag_info_blockdag_get

> models::BlockdagResponse get_blockdag_info_blockdag_get()
Get Blockdag

Get Kaspa BlockDAG information

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::BlockdagResponse**](BlockdagResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_blockreward_info_blockreward_get

> models::ResponseGetBlockrewardInfoBlockrewardGet get_blockreward_info_blockreward_get(string_only)
Get Blockreward

Returns the current blockreward in KAS/block

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**string_only** | Option<**bool**> |  |  |[default to false]

### Return type

[**models::ResponseGetBlockrewardInfoBlockrewardGet**](Response_Get_Blockreward_Info_Blockreward_Get.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_circulating_coins_info_coinsupply_circulating_get

> String get_circulating_coins_info_coinsupply_circulating_get(in_billion)
Get Circulating Coins

Get circulating amount of $KAS token as numerical value

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**in_billion** | Option<**bool**> |  |  |[default to false]

### Return type

**String**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: text/plain, application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_coinsupply_info_coinsupply_get

> models::CoinSupplyResponse get_coinsupply_info_coinsupply_get()
Get Coinsupply

Get $KAS coin supply information

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::CoinSupplyResponse**](CoinSupplyResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_fee_estimate_info_fee_estimate_get

> models::FeeEstimateResponse get_fee_estimate_info_fee_estimate_get()
Get Fee Estimate

Get fee estimate from Kaspad.  For all buckets, feerate values represent fee/mass of a transaction in `sompi/gram` units.<br> Given a feerate value recommendation, calculate the required fee by taking the transaction mass and multiplying it by feerate: `fee = feerate * mass(tx)`

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::FeeEstimateResponse**](FeeEstimateResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_halving_info_halving_get

> models::ResponseGetHalvingInfoHalvingGet get_halving_info_halving_get(field)
Get Halving

Returns information about chromatic halving

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**field** | Option<**String**> |  |  |

### Return type

[**models::ResponseGetHalvingInfoHalvingGet**](Response_Get_Halving_Info_Halving_Get.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_hashrate_history_info_hashrate_history_get

> Vec<models::HashrateHistoryResponse> get_hashrate_history_info_hashrate_history_get(resolution)
Get Hashrate History

Get historical hashrate samples with optional resolution (default = 1h)

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**resolution** | Option<**String**> |  |  |

### Return type

[**Vec<models::HashrateHistoryResponse>**](HashrateHistoryResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_hashrate_info_hashrate_get

> models::ResponseGetHashrateInfoHashrateGet get_hashrate_info_hashrate_get(string_only)
Get Hashrate

Returns the current hashrate for Kaspa network in TH/s.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**string_only** | Option<**bool**> |  |  |[default to false]

### Return type

[**models::ResponseGetHashrateInfoHashrateGet**](Response_Get_Hashrate_Info_Hashrate_Get.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_kaspad_info_info_kaspad_get

> models::KaspadInfoResponse get_kaspad_info_info_kaspad_get()
Get Kaspad Info

Get some information for kaspad instance, which is currently connected.

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::KaspadInfoResponse**](KaspadInfoResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_marketcap_info_marketcap_get

> models::ResponseGetMarketcapInfoMarketcapGet get_marketcap_info_marketcap_get(string_only)
Get Marketcap

Get $KAS price and market cap. Price info is from coingecko.com

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**string_only** | Option<**bool**> |  |  |[default to false]

### Return type

[**models::ResponseGetMarketcapInfoMarketcapGet**](Response_Get_Marketcap_Info_Marketcap_Get.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_max_hashrate_info_hashrate_max_get

> models::MaxHashrateResponse get_max_hashrate_info_hashrate_max_get()
Get Max Hashrate

Returns the current hashrate for Kaspa network in TH/s.

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::MaxHashrateResponse**](MaxHashrateResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_network_info_network_get

> models::BlockdagResponse get_network_info_network_get()
Get Network

Alias for /info/blockdag

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::BlockdagResponse**](BlockdagResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_price_info_price_get

> models::ResponseGetPriceInfoPriceGet get_price_info_price_get(string_only)
Get Price

Returns the current price for Kaspa in USD.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**string_only** | Option<**bool**> |  |  |[default to false]

### Return type

[**models::ResponseGetPriceInfoPriceGet**](Response_Get_Price_Info_Price_Get.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_total_coins_info_coinsupply_total_get

> String get_total_coins_info_coinsupply_total_get(in_billion)
Get Total Coins

Get total amount of $KAS token as numerical value

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**in_billion** | Option<**bool**> |  |  |[default to false]

### Return type

**String**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: text/plain, application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_virtual_selected_parent_blue_score_info_virtual_chain_blue_score_get

> models::BlueScoreResponse get_virtual_selected_parent_blue_score_info_virtual_chain_blue_score_get()
Get Virtual Selected Parent Blue Score

Returns the blue score of the sink

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::BlueScoreResponse**](BlueScoreResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## health_state_info_health_get

> models::HealthResponse health_state_info_health_get()
Health State

Checks node and database health by comparing blue score and sync status. Returns health details or 503 if the database lags by ~10min or no nodes are synced.

### Parameters

This endpoint does not need any parameter.

### Return type

[**models::HealthResponse**](HealthResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

