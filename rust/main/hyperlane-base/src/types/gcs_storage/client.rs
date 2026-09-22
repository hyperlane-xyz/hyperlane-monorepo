//! Authenticated GCS transport with a deadline and a cap on received response bytes.
//!
//! `ya-gcp` buffers responses before returning them and keeps its transport private.
//! Use the same OAuth implementation and request builders, but collect bodies here.

use std::time::Duration;

use bytes::Bytes;
use eyre::{bail, ensure, Context, Result};
use hyper::{body::HttpBody, client::HttpConnector, Body, Client, Request, Response, StatusCode};
use hyper_rustls::HttpsConnector;
use ya_gcp::{
    storage::api::{
        objects,
        types::{BucketName, ObjectId, ObjectName},
        ApiResponse,
    },
    AuthFlow, ServiceAccountAuth,
};
use yup_oauth2::authenticator::Authenticator;

use super::super::utils::MAX_CHECKPOINT_OBJECT_SIZE;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const READ_WRITE_SCOPE: &str = "https://www.googleapis.com/auth/devstorage.read_write";
type HttpClient = Client<HttpsConnector<HttpConnector>>;
type Auth = Authenticator<HttpsConnector<HttpConnector>>;

pub(super) struct StorageClient {
    http: HttpClient,
    auth: Option<Auth>,
}

impl StorageClient {
    pub(super) async fn new(flow: AuthFlow) -> Result<Self> {
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_native_roots()
            .https_or_http()
            .enable_http1()
            .enable_http2()
            .build();
        let http = Client::builder().build(connector);
        let auth = tokio::time::timeout(REQUEST_TIMEOUT, authentication(flow, http.clone()))
            .await
            .wrap_err("Timed out initializing GCS authentication")??;
        Ok(Self { http, auth })
    }

    async fn send(&self, request: Request<Body>) -> Result<Response<Bytes>> {
        self.send_with_timeout(request, REQUEST_TIMEOUT).await
    }

    async fn send_with_timeout(
        &self,
        mut request: Request<Body>,
        timeout: Duration,
    ) -> Result<Response<Bytes>> {
        tokio::time::timeout(timeout, async {
            if let Some(auth) = &self.auth {
                let token = auth.token(&[READ_WRITE_SCOPE]).await?;
                let token = token
                    .token()
                    .ok_or_else(|| eyre::eyre!("Missing GCS auth token"))?;
                // Do not put the token in an error or tracing field.
                let mut header = hyper::header::HeaderValue::from_str(&format!("Bearer {token}"))?;
                header.set_sensitive(true);
                request
                    .headers_mut()
                    .insert(hyper::header::AUTHORIZATION, header);
            }
            collect_response(self.http.request(request).await?).await
        })
        .await
        .wrap_err_with(|| format!("GCS request exceeded {timeout:?} deadline"))?
    }

    pub(super) async fn get_object(&self, bucket: &str, key: &str) -> Result<Option<Bytes>> {
        let oid = object_id(bucket, key)?;
        let request = objects::Object::download(&oid, None)?;
        let (parts, _) = request.into_parts();
        let response = self.send(Request::from_parts(parts, Body::empty())).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(
            objects::DownloadObjectResponse::try_from_parts(response)?.consume(),
        ))
    }

    pub(super) async fn insert_object(&self, bucket: &str, key: &str, data: Vec<u8>) -> Result<()> {
        let oid = object_id(bucket, key)?;
        let length = data.len().try_into()?;
        let request = objects::Object::insert_simple(&oid, Body::from(data), length, None)?;
        objects::InsertResponse::try_from_parts(self.send(request).await?)?;
        Ok(())
    }
}

fn object_id<'a>(bucket: &'a str, key: &'a str) -> Result<ObjectId<'a>> {
    // tame-gcs rejects dots even though GCS permits them in bucket names.
    // Names are still escaped by its request builders; validate the other rules.
    ensure!(
        (3..=63).contains(&bucket.len()),
        "Invalid GCS bucket length"
    );
    ensure!(
        bucket.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && bucket.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && bucket
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(&c)),
        "Invalid GCS bucket name"
    );
    ensure!(
        !bucket.starts_with("goog") && !bucket.contains("google") && !bucket.contains("g00gle"),
        "Invalid GCS bucket name"
    );
    Ok(ObjectId {
        bucket: BucketName::non_validated(bucket),
        object: ObjectName::try_from(key)?,
    })
}

async fn collect_response(response: Response<Body>) -> Result<Response<Bytes>> {
    let (parts, mut body) = response.into_parts();
    // Check each chunk before reserving space; headers never determine allocation.
    // Reject exactly the limit, matching the exclusive S3/local checkpoint cap.
    let mut bytes = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk?;
        ensure!(
            chunk.len() < MAX_CHECKPOINT_OBJECT_SIZE - bytes.len(),
            "GCS response exceeds checkpoint object limit of {} bytes",
            MAX_CHECKPOINT_OBJECT_SIZE
        );
        if bytes.len() + chunk.len() > bytes.capacity() {
            // Grow geometrically for tiny chunks without exceeding the byte cap.
            let additional = chunk
                .len()
                .max(bytes.capacity())
                .min(MAX_CHECKPOINT_OBJECT_SIZE - 1 - bytes.len());
            bytes.reserve_exact(additional);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Response::from_parts(parts, Bytes::from(bytes)))
}

async fn authentication(flow: AuthFlow, http: HttpClient) -> Result<Option<Auth>> {
    use yup_oauth2::{
        authenticator::ApplicationDefaultCredentialsTypes,
        ApplicationDefaultCredentialsAuthenticator, ApplicationDefaultCredentialsFlowOpts,
        AuthorizedUserAuthenticator, ServiceAccountAuthenticator,
        ServiceAccountImpersonationAuthenticator,
    };
    let auth = match flow {
        AuthFlow::NoAuth => return Ok(None),
        AuthFlow::ServiceAccount(mode) => {
            let path = match mode {
                ServiceAccountAuth::Path(path) => Some(path),
                ServiceAccountAuth::EnvVar => Some(
                    std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS")
                        .ok_or_else(|| eyre::eyre!("GOOGLE_APPLICATION_CREDENTIALS is not set"))?
                        .into(),
                ),
                ServiceAccountAuth::ApplicationDefault => None,
                _ => bail!("Unsupported GCS service-account authentication mode"),
            };
            match path {
                Some(path) => {
                    ServiceAccountAuthenticator::builder(
                        yup_oauth2::read_service_account_key(path).await?,
                    )
                    .hyper_client(http)
                    .build()
                    .await?
                }
                None => match ApplicationDefaultCredentialsAuthenticator::with_client(
                    ApplicationDefaultCredentialsFlowOpts::default(),
                    http,
                )
                .await
                {
                    ApplicationDefaultCredentialsTypes::ServiceAccount(builder) => {
                        builder.build().await?
                    }
                    ApplicationDefaultCredentialsTypes::InstanceMetadata(builder) => {
                        builder.build().await?
                    }
                },
            }
        }
        AuthFlow::UserAccount(path) => {
            AuthorizedUserAuthenticator::with_client(
                yup_oauth2::read_authorized_user_secret(path).await?,
                http,
            )
            .build()
            .await?
        }
        AuthFlow::ServiceAccountImpersonation { user, email } => {
            ServiceAccountImpersonationAuthenticator::with_client(
                yup_oauth2::read_authorized_user_secret(user).await?,
                &email,
                http,
            )
            .build()
            .await?
        }
        _ => bail!("Unsupported GCS authentication flow"),
    };
    Ok(Some(auth))
}

#[cfg(test)]
#[path = "client/tests.rs"]
mod tests;
