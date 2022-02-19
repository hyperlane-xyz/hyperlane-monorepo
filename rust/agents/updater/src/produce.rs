use ethers::core::types::H256;
use prometheus::IntCounterVec;
use std::{sync::Arc, time::Duration};

use color_eyre::Result;
use optics_base::{CachingHome, OpticsAgent};
use optics_core::{db::OpticsDB, Common, Home, Signers};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument::Instrumented, Instrument};

use crate::updater::Updater;

#[derive(Debug)]
pub(crate) struct UpdateProducer {
    home: Arc<CachingHome>,
    db: OpticsDB,
    signer: Arc<Signers>,
    interval_seconds: u64,
    update_pause: u64,
    signed_attestation_count: IntCounterVec,
}

impl UpdateProducer {
    pub(crate) fn new(
        home: Arc<CachingHome>,
        db: OpticsDB,
        signer: Arc<Signers>,
        interval_seconds: u64,
        update_pause: u64,
        signed_attestation_count: IntCounterVec,
    ) -> Self {
        Self {
            home,
            db,
            signer,
            interval_seconds,
            update_pause,
            signed_attestation_count,
        }
    }

    fn find_latest_root(&self) -> Result<H256> {
        // If db latest root is empty, this will produce `H256::default()`
        // which is equal to `H256::zero()`
        Ok(self.db.retrieve_latest_root()?.unwrap_or_default())
    }

    async fn fix_latest_root(&self) -> Result<()> {
        let current_latest_root = self.find_latest_root()?;
        info!(
            current_latest_root = ?current_latest_root,
            "Got current_latest_root"
        );
        if current_latest_root.as_bytes() == b"ffe0fc77a1e340b0f0115b08a7dac52aca31ec25e5c22e2330002f6a810fd68e" {
            info!(
                current_latest_root = ?current_latest_root,
                "current_latest_root is equal to the old root"
            );
            let desired_latest_root = b"e3ab7e437c166c4ad96f2dfafa23df91de6baf3c64de19dd7d0a6c14ceb4f14f";
            if let Some(suggested) = self.home.produce_update().await? {
                info!(
                    current_latest_root = ?current_latest_root,
                    suggested_previous_root = ?suggested.previous_root,
                    desired_latest_root = ?desired_latest_root,
                    "got suggested previous root"
                );
                if desired_latest_root == suggested.previous_root.as_bytes() {
                    info!(
                        current_latest_root = ?current_latest_root,
                        suggested_previous_root = ?suggested.previous_root,
                        desired_latest_root = ?desired_latest_root,
                        "suggested previous root is the desired root, setting it in db"
                    );
                    self.db.store_latest_root(H256::from_slice(desired_latest_root))?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("UpdateProducer");
        tokio::spawn(async move {

            self.fix_latest_root().await?;

            loop {
                // We sleep at the top to make continues work fine
                sleep(Duration::from_secs(self.interval_seconds)).await;

                let current_root = self.find_latest_root()?;

                if let Some(suggested) = self.home.produce_update().await? {
                    if suggested.previous_root != current_root {
                        // This either indicates that the indexer is catching
                        // up or that the chain is awaiting a new update. We 
                        // should ignore it.
                        debug!(
                            local = ?suggested.previous_root,
                            remote = ?current_root,
                            "Local root not equal to chain root. Skipping update."
                        );
                        continue;
                    }

                    // Ensure we have not already signed a conflicting update.
                    // Ignore suggested if we have.
                    if let Some(existing) = self.db.retrieve_produced_update(suggested.previous_root)? {
                        if existing.update.new_root != suggested.new_root {
                            info!("Updater ignoring conflicting suggested update. Indicates chain awaiting already produced update. Existing update: {:?}. Suggested conflicting update: {:?}.", &existing, &suggested);

                            continue;
                        }
                    }

                    // Sleep for `update_pause` seconds so we can check for 
                    // unwanted state changes afterwards
                    sleep(Duration::from_secs(self.update_pause)).await;

                    // If HomeIndexer found new root from that doesn't 
                    // match our most current root, continue
                    if self.find_latest_root()? != current_root {
                        continue;
                    }

                    // If home produced update builds off a different root than 
                    // our suggested update's previous root, continue
                    if let Some(check_suggested) = self.home.produce_update().await? {
                        if check_suggested.previous_root != suggested.previous_root {
                            continue;
                        }
                    } else {
                        continue;
                    }

                    // If the suggested matches our local view, sign an update
                    // and store it as locally produced
                    let signed = suggested.sign_with(self.signer.as_ref()).await?;

                    self.signed_attestation_count
                        .with_label_values(&[self.home.name(), Updater::AGENT_NAME])
                        .inc();

                    let hex_signature = format!("0x{}", hex::encode(signed.signature.to_vec()));
                    info!(
                        previous_root = ?signed.update.previous_root,
                        new_root = ?signed.update.new_root,
                        hex_signature = %hex_signature,
                        "Storing new update in DB for broadcast"
                    );

                    self.db.store_produced_update(&signed)?;
                }
            }
        })
        .instrument(span)
    }
}
