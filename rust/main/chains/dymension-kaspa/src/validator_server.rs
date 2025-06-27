use super::endpoints::*;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use dym_kas_core::deposit::DepositFXG;
use dym_kas_core::{confirmation::ConfirmationFXG, withdraw::WithdrawFXG};
use dym_kas_validator::withdraw::sign_pskt;
pub use dym_kas_validator::KaspaSecpKeypair;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, Signable, H256};
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use kaspa_wallet_pskt::prelude::*;
use sha3::{digest::Update, Digest, Keccak256};
use std::{str::FromStr, sync::Arc};

use super::providers::KaspaProvider;
use dym_kas_validator::confirmation::validate_confirmed_withdrawals;
use dym_kas_validator::deposit::validate_deposits;
use dym_kas_validator::withdrawal::validate_withdrawals;

#[derive(Clone)]
pub struct ValidatorServerResources<S: HyperlaneSignerExt + Send + Sync + 'static> {
    signer: Option<Arc<S>>,
    kas_provider: Option<Box<KaspaProvider>>, // TODO: box, need multithread object? need to lock when signing?
}
impl<S: HyperlaneSignerExt + Send + Sync + 'static> ValidatorServerResources<S> {
    pub fn new(signer: Arc<S>, kas_provider: Box<KaspaProvider>) -> Self {
        Self {
            signer: Some(signer),
            kas_provider: Some(kas_provider),
        }
    }
    fn must_signer(&self) -> Arc<S> {
        self.signer.as_ref().unwrap().clone()
    }
    fn must_kas_key(&self) -> KaspaSecpKeypair {
        self.kas_provider.as_ref().unwrap().must_kas_key()
    }
    pub fn default() -> Self {
        Self {
            signer: None,
            kas_provider: None,
        }
    }
}

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
        .with_state(Arc::new(resources))
}

async fn respond_validate_new_deposits<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<String>> {
    let deposits: DepositFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator.G()
    if !validate_deposits(&deposits)
        .await
        .map_err(|e| AppError(e))?
    {
        return Err(AppError(eyre::eyre!("Invalid deposit")));
    }

    let message_id = H256::random(); // TODO: extract from FXG
    let domain = 1; // TODO: extract from FXG

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
        .must_signer()
        .sign(to_sign) // TODO: need to lock first?
        .await
        .map_err(|e| AppError(e.into()))?;

    let j =
        serde_json::to_string_pretty(&sig).map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

async fn respond_validate_confirmed_withdrawals<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<String>> {
    let confirmation_fxg: ConfirmationFXG =
        body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator.G()
    if !validate_confirmed_withdrawals(&confirmation_fxg)
        .await
        .map_err(|e| AppError(e))?
    {
        return Err(AppError(eyre::eyre!("Invalid confirmation")));
    }

    let progress_indication = &confirmation_fxg.progress_indication;

    let sig = resources
        .must_signer() // TODO: need to lock?
        .sign(SignableProgressIndication {
            progress_indication: progress_indication.clone(),
        })
        .await
        .map_err(|e| AppError(e.into()))?;

    let j = serde_json::to_string_pretty(&sig.signature)
        .map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

struct SignableProgressIndication {
    progress_indication: ProgressIndication,
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

/// Allows automatic error mapping
struct AppError(eyre::Report);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        eprintln!("Error: {:?}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal error occurred".to_string(),
        )
            .into_response()
    }
}

/// Allows handler to have some state
type HandlerResult<T> = Result<T, AppError>;

async fn respond_sign_pskts<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(resources): State<Arc<ValidatorServerResources<S>>>,
    body: Bytes,
) -> HandlerResult<Json<String>> {
    let fxg: WithdrawFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator.G()
    if !validate_withdrawals(&fxg).await.map_err(|e| AppError(e))? {
        return Err(AppError(eyre::eyre!("Invalid confirmation")));
    }

    let mut signed = Vec::new();
    for pskt in fxg.bundle.iter() {
        let pskt = PSKT::<Signer>::from(pskt.clone());
        let signed_pskt =
            sign_pskt(&resources.must_kas_key(), pskt).map_err(|e| AppError(e.into()))?;
        signed.push(signed_pskt);
    }
    let bundle = Bundle::from(signed);

    let stringy = bundle
        .serialize()
        .map_err(|e| AppError(eyre::eyre!("Oops!")))?; // TODO: better error

    let j = serde_json::to_string_pretty(&stringy)
        .map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}
