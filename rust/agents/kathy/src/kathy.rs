use std::{sync::Arc, time::Duration};

use ethers::core::types::H256;
use eyre::{Result, WrapErr};
use rand::distributions::Alphanumeric;
use rand::{thread_rng, Rng};
use tokio::{sync::Mutex, task::JoinHandle, time::sleep};
use tracing::instrument::Instrumented;
use tracing::{info, Instrument};

use abacus_base::{decl_agent, run_all, AbacusAgentCore, Agent, BaseAgent, CachingInbox};
use abacus_core::{AbacusCommon, Message, Outbox};

decl_agent!(Kathy {
    duration: u64,
    generator: ChatGenerator,
    outbox_lock: Arc<Mutex<()>>,
});

impl Kathy {
    pub fn new(duration: u64, generator: ChatGenerator, core: AbacusAgentCore) -> Self {
        Self {
            duration,
            generator,
            core,
            outbox_lock: Arc::new(Mutex::new(())),
        }
    }
}

#[async_trait::async_trait]
impl BaseAgent for Kathy {
    const AGENT_NAME: &'static str = "kathy";

    type Settings = crate::settings::KathySettings;

    async fn from_settings(settings: Self::Settings) -> Result<Self> {
        Ok(Self::new(
            settings.interval.parse().expect("invalid u64"),
            settings.chat.into(),
            settings
                .base
                .try_into_abacus_core(Self::AGENT_NAME, true)
                .await?,
        ))
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let inbox_tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox_contracts)| {
                self.wrap_inbox_run(inbox_name, inbox_contracts.inbox.clone())
            })
            .collect();
        run_all(inbox_tasks)
    }
}

impl Kathy {
    #[tracing::instrument]
    fn run_inbox(&self, inbox: Arc<CachingInbox>) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let outbox_lock = self.outbox_lock.clone();

        let mut generator = self.generator.clone();
        let duration = Duration::from_secs(self.duration);

        tokio::spawn(async move {
            let destination = inbox.local_domain();

            loop {
                let msg = generator.gen_chat();
                let recipient = generator.gen_recipient();

                match msg {
                    Some(body) => {
                        let message = Message {
                            destination,
                            recipient,
                            body,
                        };
                        info!(
                            target: "outgoing_messages",
                            "Enqueuing message of length {} to {}::{}",
                            length = message.body.len(),
                            destination = message.destination,
                            recipient = message.recipient
                        );

                        let guard = outbox_lock.lock().await;
                        outbox.dispatch(&message).await?;
                        drop(guard);
                    }
                    _ => {
                        info!("Reached the end of the static message queue. Shutting down.");
                        return Ok(());
                    }
                }

                sleep(duration).await;
            }
        })
        .in_current_span()
    }

    fn wrap_inbox_run(
        &self,
        inbox_name: &str,
        inbox: Arc<CachingInbox>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let m = format!("Task for inbox named {} failed", inbox_name);
        let handle = self.run_inbox(inbox).in_current_span();
        let fut = async move { handle.await?.wrap_err(m) };

        tokio::spawn(fut).in_current_span()
    }
}

/// Generators for messages
#[derive(Debug, Clone)]
pub enum ChatGenerator {
    Static {
        recipient: H256,
        message: String,
    },
    OrderedList {
        messages: Vec<String>,
        counter: usize,
    },
    Random {
        length: usize,
    },
    Default,
}

impl Default for ChatGenerator {
    fn default() -> Self {
        Self::Default
    }
}

impl ChatGenerator {
    fn rand_string(length: usize) -> String {
        thread_rng()
            .sample_iter(&Alphanumeric)
            .take(length)
            .map(char::from)
            .collect()
    }

    pub fn gen_recipient(&mut self) -> H256 {
        match self {
            ChatGenerator::Default => Default::default(),
            ChatGenerator::Static {
                recipient,
                message: _,
            } => *recipient,
            ChatGenerator::OrderedList {
                messages: _,
                counter: _,
            } => Default::default(),
            ChatGenerator::Random { length: _ } => H256::random(),
        }
    }

    pub fn gen_chat(&mut self) -> Option<Vec<u8>> {
        match self {
            ChatGenerator::Default => Some(Default::default()),
            ChatGenerator::Static {
                recipient: _,
                message,
            } => Some(message.as_bytes().to_vec()),
            ChatGenerator::OrderedList { messages, counter } => {
                if *counter >= messages.len() {
                    return None;
                }

                let msg = messages[*counter].clone().into();

                // Increment counter to next message in list
                *counter += 1;

                Some(msg)
            }
            ChatGenerator::Random { length } => Some(Self::rand_string(*length).into()),
        }
    }
}
