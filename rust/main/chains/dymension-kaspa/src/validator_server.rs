use super::conf::ValidatorStuff;
use super::endpoints::*;
use super::providers::KaspaProvider;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use dym_kas_core::api::client::HttpClient;
use dym_kas_core::deposit::DepositFXG;
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::wallet::EasyKaspaWallet;
use dym_kas_core::{confirmation::ConfirmationFXG, withdraw::WithdrawFXG};
use dym_kas_validator::confirmation::validate_confirmed_withdrawals;
use dym_kas_validator::deposit::{validate_new_deposit, MustMatch as DepositMustMatch};
use dym_kas_validator::withdraw::{validate_sign_withdrawal_fxg, MustMatch as WithdrawMustMatch};
pub use dym_kas_validator::KaspaSecpKeypair;
use eyre::Report;
use hyperlane_core::{
    Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, Signable,
    SignedCheckpointWithMessageId, H256,
};
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, Signature as HLCoreSignature};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use hyperlane_cosmos_rs::prost::Message;
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_pskt::prelude::*;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha3::{digest::Update, Digest, Keccak256};
use std::sync::Arc;
use tracing::{info, warn};

/// Allows automatic error mapping
struct AppError(eyre::Report);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let err_msg = self.0.to_string();
        eprintln!("Validator error: {}", err_msg);

        // Return the actual error message in the response body
        // This ensures the relayer gets meaningful error information
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Validation failed: {}", err_msg),
        )
            .into_response()
    }
}

/// Allows handler to have some state
type HandlerResult<T> = Result<T, AppError>;

/// Signer here refers to the typical Hyperlane signer which will need to sign attestations to be able to relay TO the hub
pub fn router<S: HyperlaneSignerExt + Send + Sync + 'static>(
    resources: ValidatorServerResources<S>,
) -> Router {
    Router::new()
        .route(
            ROUTE_VALIDATE_NEW_DEPOSITS,
            post(respond_validate_new_deposits::<S>),
        )
        .route(
            ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS,
            post(respond_validate_confirmed_withdrawals::<S>),
        )
        .route(ROUTE_SIGN_PSKTS, post(respond_sign_pskts::<S>))
        .route("/kaspa-ping", post(respond_kaspa_ping::<S>))
        .with_state(Arc::new(resources))
}

async fn respond_kaspa_ping<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(_): State<Arc<ValidatorServerResources<S>>>,
    _body: Bytes,
) -> HandlerResult<Json<String>> {
    warn!("VALIDATOR SERVER, GOT KASPA PING");
    Ok(Json("pong".to_string()))
}

/// dococo
#[derive(Clone)]
pub struct ValidatorServerResources<S: HyperlaneSignerExt + Send + Sync + 'static> {
    ism_signer: Option<Arc<S>>,
    kas_provider: Option<Box<KaspaProvider>>, // TODO: box, need multithread object? need to lock when signing?
}

impl<S: HyperlaneSignerExt + Send + Sync + 'static> ValidatorServerResources<S> {
    /// dococo
    pub fn new(signer: Arc<S>, kas_provider: Box<KaspaProvider>) -> Self {
        Self {
            ism_signer: Some(signer),
            kas_provider: Some(kas_provider),
        }
    }
    fn must_ism_signer(&self) -> Arc<S> {
        self.ism_signer.as_ref().unwrap().clone()
    }
    fn must_kas_key(&self) -> KaspaSecpKeypair {
        self.kas_provider.as_ref().unwrap().must_kas_key()
    }
    fn must_api(&self) -> Arc<DynRpcApi> {
        self.must_wallet().api()
    }

    fn must_escrow(&self) -> EscrowPublic {
        self.kas_provider.as_ref().unwrap().escrow()
    }

    fn must_wallet(&self) -> &EasyKaspaWallet {
        self.kas_provider.as_ref().unwrap().wallet()
    }

    fn must_hub_rpc(&self) -> &CosmosGrpcClient {
        self.kas_provider.as_ref().unwrap().hub_rpc()
    }

    pub fn must_kas_domain(&self) -> &HyperlaneDomain {
        self.kas_provider.as_ref().unwrap().domain()
    }

    fn must_rest_client(&self) -> &HttpClient {
        &self.kas_provider.as_ref().unwrap().rest().client.client
    }

    fn must_val_stuff(&self) -> &ValidatorStuff {
        self.kas_provider.as_ref().unwrap().must_validator_stuff()
    }
}

impl<S: HyperlaneSignerExt + Send + Sync + 'static> Default for ValidatorServerResources<S> {
    fn default() -> Self {
        Self {
            ism_signer: None,
            kas_provider: None,
        }
    }
}

async fn respond_validate_new_deposits<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<SignedCheckpointWithMessageId>> {
    info!("Validator: checking new kaspa deposit");
    let deposits: DepositFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;
    // Call to validator.G()
    if resources.must_val_stuff().toggles.deposit_enabled {
        validate_new_deposit(
            &resources.must_api(),
            resources.must_rest_client(),
            &deposits,
            &resources.must_wallet().net,
            &resources.must_escrow().addr,
            resources.must_hub_rpc(),
            DepositMustMatch::new(
                resources.must_val_stuff().hub_domain,
                resources.must_val_stuff().hub_token_id,
                resources.must_val_stuff().kas_domain,
                resources.must_val_stuff().kas_token_placeholder,
            ),
        )
        .await
        .map_err(|e| {
            // Log the detailed error for debugging
            eprintln!("Deposit validation failed: {:?}", e);
            AppError(Report::from(e))
        })?;
    }
    info!(
        "Validator: deposit is valid: id = {:?}",
        deposits.hl_message.id()
    );

    let message_id = deposits.hl_message.id();
    let domain = deposits.hl_message.origin;

    let zero_array = [0u8; 32];
    let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            mailbox_domain: domain,
            merkle_tree_hook_address: H256::from_slice(&zero_array),
            root: H256::from_slice(&zero_array),
            index: 0,
        },
        message_id,
    };

    let sig = resources
        .must_ism_signer()
        .sign(to_sign) // TODO: need to lock first?
        .await
        .map_err(|e| AppError(e.into()))?;
    info!("Validator: signed deposit");

    Ok(Json(sig))
}

async fn respond_sign_pskts<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<Bundle>> {
    info!("Validator: signing pskts");

    let fxg: WithdrawFXG = body.try_into().map_err(|e: Report| AppError(e))?;
    let escrow = resources.must_escrow();
    let val_stuff = resources.must_val_stuff();

    let bundle = validate_sign_withdrawal_fxg(
        fxg,
        val_stuff.toggles.withdrawal_enabled,
        resources.must_hub_rpc(),
        escrow,
        &resources.must_kas_key(),
        WithdrawMustMatch::new(
            resources.must_wallet().net.address_prefix,
            resources.must_escrow(),
            val_stuff.hub_domain,
            val_stuff.hub_token_id,
            val_stuff.kas_domain,
            val_stuff.kas_token_placeholder,
            val_stuff.hub_mailbox_id.clone(),
        ),
    )
    .await
    .map_err(|e| {
        eprintln!("Withdrawal validation and singing failed: {:?}", e);
        AppError(Report::from(e))
    })?;

    Ok(Json(bundle))
}

pub struct SignableProgressIndication {
    progress_indication: ProgressIndication,
}

impl Serialize for SignableProgressIndication {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = self.progress_indication.encode_to_vec();
        serializer.serialize_bytes(&encoded)
    }
}

impl<'de> Deserialize<'de> for SignableProgressIndication {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let bytes = Bytes::deserialize(deserializer)?;
        let progress_indication =
            ProgressIndication::decode(bytes.as_ref()).map_err(serde::de::Error::custom)?;
        Ok(SignableProgressIndication {
            progress_indication,
        })
    }
}

impl Signable for SignableProgressIndication {
    fn signing_hash(&self) -> H256 {
        // see bytes derivation https://github.com/dymensionxyz/dymension/blob/64f69cae45ea93797299b97716e63bcada64ca25/x/kas/types/d.go#L87-L98
        // see checkpoint example https://github.com/dymensionxyz/hyperlane-monorepo/blob/b372a9062d8cc6de604c32cc0ba200337707c350/rust/main/hyperlane-core/src/types/checkpoint.rs#L35

        let mut bz = vec![];
        bz.extend(
            self.progress_indication
                .old_outpoint
                .clone()
                .unwrap()
                .transaction_id,
        );
        bz.extend(
            self.progress_indication
                .old_outpoint
                .clone()
                .unwrap()
                .index
                .to_be_bytes(),
        );
        bz.extend(
            self.progress_indication
                .new_outpoint
                .clone()
                .unwrap()
                .transaction_id,
        );
        bz.extend(
            self.progress_indication
                .new_outpoint
                .clone()
                .unwrap()
                .index
                .to_be_bytes(),
        );
        for w in self.progress_indication.processed_withdrawals.clone() {
            bz.extend(w.message_id.as_bytes());
        }
        H256::from_slice(Keccak256::new().chain(bz).finalize().as_slice())
    }
}

async fn respond_validate_confirmed_withdrawals<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<HLCoreSignature>> {
    info!("Validator: checking confirmed kaspa withdrawal");
    let confirmation_fxg: ConfirmationFXG =
        body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator
    if resources
        .must_val_stuff()
        .toggles
        .withdrawal_confirmation_enabled
    {
        validate_confirmed_withdrawals(
            &confirmation_fxg,
            resources.must_rest_client(),
            &resources.must_escrow().addr,
        )
        .await
        .map_err(|e| {
            eprintln!("Withdrawal confirmation validation failed: {:?}", e);
            AppError(Report::from(e))
        })?;
        info!("Validator: confirmed withdrawal is valid");
    }

    let progress_indication = &confirmation_fxg.progress_indication;

    let sig = resources
        .must_ism_signer() // TODO: need to lock?
        .sign(SignableProgressIndication {
            progress_indication: progress_indication.clone(),
        })
        .await
        .map_err(|e| AppError(e.into()))?;

    info!("Validator: signed confirmed withdrawal");

    Ok(Json(sig.signature))
}
