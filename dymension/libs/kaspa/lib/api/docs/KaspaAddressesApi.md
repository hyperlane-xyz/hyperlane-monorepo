# \KaspaAddressesApi

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**get_addresses_active_addresses_active_post**](KaspaAddressesApi.md#get_addresses_active_addresses_active_post) | **POST** /addresses/active | Get Addresses Active
[**get_addresses_names_addresses_names_get**](KaspaAddressesApi.md#get_addresses_names_addresses_names_get) | **GET** /addresses/names | Get Addresses Names
[**get_balance_from_kaspa_address_addresses_kaspa_address_balance_get**](KaspaAddressesApi.md#get_balance_from_kaspa_address_addresses_kaspa_address_balance_get) | **GET** /addresses/{kaspaAddress}/balance | Get Balance From Kaspa Address
[**get_balances_from_kaspa_addresses_addresses_balances_post**](KaspaAddressesApi.md#get_balances_from_kaspa_addresses_addresses_balances_post) | **POST** /addresses/balances | Get Balances From Kaspa Addresses
[**get_full_transactions_for_address_addresses_kaspa_address_full_transactions_get**](KaspaAddressesApi.md#get_full_transactions_for_address_addresses_kaspa_address_full_transactions_get) | **GET** /addresses/{kaspaAddress}/full-transactions | Get Full Transactions For Address
[**get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get**](KaspaAddressesApi.md#get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get) | **GET** /addresses/{kaspaAddress}/full-transactions-page | Get Full Transactions For Address Page
[**get_name_for_address_addresses_kaspa_address_name_get**](KaspaAddressesApi.md#get_name_for_address_addresses_kaspa_address_name_get) | **GET** /addresses/{kaspaAddress}/name | Get Name For Address
[**get_transaction_count_for_address_addresses_kaspa_address_transactions_count_get**](KaspaAddressesApi.md#get_transaction_count_for_address_addresses_kaspa_address_transactions_count_get) | **GET** /addresses/{kaspaAddress}/transactions-count | Get Transaction Count For Address
[**get_utxos_for_address_addresses_kaspa_address_utxos_get**](KaspaAddressesApi.md#get_utxos_for_address_addresses_kaspa_address_utxos_get) | **GET** /addresses/{kaspaAddress}/utxos | Get Utxos For Address
[**get_utxos_for_addresses_addresses_utxos_post**](KaspaAddressesApi.md#get_utxos_for_addresses_addresses_utxos_post) | **POST** /addresses/utxos | Get Utxos For Addresses



## get_addresses_active_addresses_active_post

> Vec<models::TxIdResponse> get_addresses_active_addresses_active_post(addresses_active_request)
Get Addresses Active

This endpoint checks if addresses have had any transaction activity in the past. It is specifically designed for HD Wallets to verify historical address activity.

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**addresses_active_request** | [**AddressesActiveRequest**](AddressesActiveRequest.md) |  | [required] |

### Return type

[**Vec<models::TxIdResponse>**](TxIdResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_addresses_names_addresses_names_get

> Vec<models::AddressName> get_addresses_names_addresses_names_get()
Get Addresses Names

Get the name for an address

### Parameters

This endpoint does not need any parameter.

### Return type

[**Vec<models::AddressName>**](AddressName.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_balance_from_kaspa_address_addresses_kaspa_address_balance_get

> models::BalanceResponse get_balance_from_kaspa_address_addresses_kaspa_address_balance_get(kaspa_address)
Get Balance From Kaspa Address

Get balance for a given kaspa address

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73 | [required] |

### Return type

[**models::BalanceResponse**](BalanceResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_balances_from_kaspa_addresses_addresses_balances_post

> Vec<models::BalancesByAddressEntry> get_balances_from_kaspa_addresses_addresses_balances_post(balance_request)
Get Balances From Kaspa Addresses

Get balances for multiple kaspa addresses

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**balance_request** | [**BalanceRequest**](BalanceRequest.md) |  | [required] |

### Return type

[**Vec<models::BalancesByAddressEntry>**](BalancesByAddressEntry.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_full_transactions_for_address_addresses_kaspa_address_full_transactions_get

> Vec<models::TxModel> get_full_transactions_for_address_addresses_kaspa_address_full_transactions_get(kaspa_address, limit, offset, fields, resolve_previous_outpoints)
Get Full Transactions For Address

Get all transactions for a given address from database. And then get their related full transaction data

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73 | [required] |
**limit** | Option<**i32**> | The number of records to get |  |[default to 50]
**offset** | Option<**i32**> | The offset from which to get records |  |[default to 0]
**fields** | Option<**String**> |  |  |[default to ]
**resolve_previous_outpoints** | Option<**String**> | Use this parameter if you want to fetch the TransactionInput previous outpoint details. Light fetches only the adress and amount. Full fetches the whole TransactionOutput and adds it into each TxInput. |  |[default to no]

### Return type

[**Vec<models::TxModel>**](TxModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get

> Vec<models::TxModel> get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get(kaspa_address, limit, before, after, fields, resolve_previous_outpoints, acceptance)
Get Full Transactions For Address Page

Get all transactions for a given address from database. And then get their related full transaction data

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73 | [required] |
**limit** | Option<**i32**> | The max number of records to get. For paging combine with using 'before/after' from oldest previous result. Use value of X-Next-Page-Before/-After as long as header is present to continue paging. The actual number of transactions returned for each page can be > limit. |  |[default to 50]
**before** | Option<**i32**> | Only include transactions with block time before this (epoch-millis) |  |[default to 0]
**after** | Option<**i32**> | Only include transactions with block time after this (epoch-millis) |  |[default to 0]
**fields** | Option<**String**> |  |  |[default to ]
**resolve_previous_outpoints** | Option<**String**> | Use this parameter if you want to fetch the TransactionInput previous outpoint details. Light fetches only the adress and amount. Full fetches the whole TransactionOutput and adds it into each TxInput. |  |[default to no]
**acceptance** | Option<[**AcceptanceMode**](.md)> |  |  |

### Return type

[**Vec<models::TxModel>**](TxModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_name_for_address_addresses_kaspa_address_name_get

> models::AddressName get_name_for_address_addresses_kaspa_address_name_get(kaspa_address)
Get Name For Address

Get the name for an address

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e | [required] |

### Return type

[**models::AddressName**](AddressName.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_transaction_count_for_address_addresses_kaspa_address_transactions_count_get

> models::TransactionCount get_transaction_count_for_address_addresses_kaspa_address_transactions_count_get(kaspa_address)
Get Transaction Count For Address

Count the number of transactions associated with this address

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73 | [required] |

### Return type

[**models::TransactionCount**](TransactionCount.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_utxos_for_address_addresses_kaspa_address_utxos_get

> Vec<models::UtxoResponse> get_utxos_for_address_addresses_kaspa_address_utxos_get(kaspa_address)
Get Utxos For Address

Lists all open utxo for a given kaspa address

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**kaspa_address** | **String** | Kaspa address as string e.g. kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73 | [required] |

### Return type

[**Vec<models::UtxoResponse>**](UtxoResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## get_utxos_for_addresses_addresses_utxos_post

> Vec<models::UtxoResponse> get_utxos_for_addresses_addresses_utxos_post(utxo_request)
Get Utxos For Addresses

Lists all open utxo for a given kaspa address

### Parameters


Name | Type | Description  | Required | Notes
------------- | ------------- | ------------- | ------------- | -------------
**utxo_request** | [**UtxoRequest**](UtxoRequest.md) |  | [required] |

### Return type

[**Vec<models::UtxoResponse>**](UtxoResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

