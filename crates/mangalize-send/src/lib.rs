//! Delivering a finished volume to a device by email.
//!
//! This is how "send to Kindle" works: Amazon gives every device an address,
//! and a document mailed to it appears in the library. There is no API, which is
//! why Calibre does the same thing.
//!
//! Two constraints from outside this crate shape everything here, and both fail
//! in ways that look like a bug in *this* program:
//!
//! - Amazon only accepts mail from an address on the account's **Approved
//!   Personal Document E-mail List**. Mail from anywhere else is discarded
//!   silently — no bounce, no error, nothing to observe.
//! - A volume is a large attachment. Amazon caps the whole message at 50 MB, and
//!   mail providers cap attachments independently and lower: Gmail stops at 25
//!   MB. Base64 inflates the file by about a third on the way out, so the
//!   readable limit is well below the number either of them advertises.
//!
//! Both are checked or explained before a send is attempted, because neither
//! produces a useful error on its own.

use anyhow::{bail, Context, Result};
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Body, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};

/// How the connection to the mail server is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Security {
    /// Connect in the clear, then upgrade. Port 587, and what most providers want.
    StartTls,
    /// TLS from the first byte. Port 465.
    Tls,
    /// No encryption at all. Only sane for a server on your own machine.
    None,
}

/// The mail account a volume is sent from.
///
/// The password is deliberately not a field: it lives in the OS keychain and is
/// passed in for the duration of one send, so it is never part of anything that
/// might be serialised, logged or written to a config file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// Blank for a server that wants no authentication.
    pub username: String,
    /// The `From:` address. This is the one Amazon must have approved.
    pub from: String,
}

/// One volume, ready to send.
pub struct Delivery<'a> {
    /// The device address, e.g. `something@kindle.com`.
    pub to: &'a str,
    /// Filename as it should arrive; becomes the title in the device library.
    pub filename: &'a str,
    pub bytes: Vec<u8>,
}

/// Amazon's ceiling for a whole message, attachment and headers together.
const AMAZON_MAX_MESSAGE: usize = 50 * 1024 * 1024;

/// What most providers allow per attachment. Gmail is the common case and the
/// tightest of the big three.
const TYPICAL_PROVIDER_MAX: usize = 25 * 1024 * 1024;

/// Size an attachment occupies once base64-encoded, which is what actually
/// travels and what the limits are measured against.
pub fn encoded_size(bytes: usize) -> usize {
    // 4 bytes out per 3 in, plus line breaks every 76 characters.
    let base = bytes.div_ceil(3) * 4;
    base + base / 76
}

/// Whether a file is too large to arrive, and why.
///
/// Returns the explanation rather than a bool so the caller can say which limit
/// was hit; "too big" on its own sends people hunting in the wrong place.
pub fn size_problem(bytes: usize) -> Option<String> {
    let encoded = encoded_size(bytes);
    let mb = |n: usize| n as f64 / 1_048_576.0;

    if encoded > AMAZON_MAX_MESSAGE {
        return Some(format!(
            "{:.1} MB becomes about {:.1} MB once encoded for email, over Amazon's 50 MB limit. \
             Split the volume, or send it over USB instead.",
            mb(bytes),
            mb(encoded)
        ));
    }
    if encoded > TYPICAL_PROVIDER_MAX {
        return Some(format!(
            "{:.1} MB becomes about {:.1} MB once encoded for email. Amazon would accept it, \
             but most providers cap attachments at 25 MB — Gmail included — and will reject it.",
            mb(bytes),
            mb(encoded)
        ));
    }
    None
}

/// Send one volume.
///
/// Blocking: the caller is expected to be on a worker already, as everything in
/// this app that touches the network is.
pub fn send(account: &Account, password: &str, delivery: &Delivery) -> Result<()> {
    if delivery.to.trim().is_empty() {
        bail!("no device address set");
    }
    if account.from.trim().is_empty() {
        bail!("no sender address set");
    }
    if let Some(problem) = size_problem(delivery.bytes.len()) {
        bail!("{problem}");
    }

    let message = build(account, delivery)?;
    transport(account, password)?
        .send(&message)
        .map_err(|e| enrich(e, account))?;
    Ok(())
}

/// Check the account works without sending a document.
///
/// Worth its own path: an empty message proves the host, port, TLS mode and
/// password are right, which is all of the setup that can be wrong in a way the
/// user can fix. It cannot prove Amazon has approved the sender, because nothing
/// can — that failure is invisible by design.
pub fn send_test(account: &Account, password: &str, to: &str) -> Result<()> {
    let message = Message::builder()
        .from(account.from.parse().context("sender address is not valid")?)
        .to(to.parse().context("device address is not valid")?)
        .subject("Mangalize test")
        .header(ContentType::TEXT_PLAIN)
        .body(String::from(
            "Mangalize can reach your mail server.\n\n\
             If this never arrives on your device, the sender address is most \
             likely missing from Amazon's Approved Personal Document E-mail List.",
        ))
        .context("building the test message")?;

    transport(account, password)?
        .send(&message)
        .map_err(|e| enrich(e, account))?;
    Ok(())
}

fn build(account: &Account, delivery: &Delivery) -> Result<Message> {
    let attachment = Attachment::new(delivery.filename.to_string()).body(
        Body::new(delivery.bytes.clone()),
        content_type(delivery.filename),
    );

    Message::builder()
        .from(account.from.parse().context("sender address is not valid")?)
        .to(delivery.to.parse().context("device address is not valid")?)
        // Amazon uses the attachment's filename as the title, not the subject,
        // so the subject is only ever for the user's own mailbox.
        .subject(delivery.filename.to_string())
        .multipart(
            MultiPart::mixed()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(String::from("Sent by Mangalize.")),
                )
                .singlepart(attachment),
        )
        .context("building the message")
}

fn transport(account: &Account, password: &str) -> Result<SmtpTransport> {
    let host = account.host.trim();
    if host.is_empty() {
        bail!("no mail server set");
    }

    let builder = match account.security {
        Security::Tls => SmtpTransport::relay(host).context("configuring TLS")?,
        Security::StartTls => SmtpTransport::starttls_relay(host).context("configuring STARTTLS")?,
        Security::None => SmtpTransport::builder_dangerous(host),
    };

    let builder = builder.port(account.port);
    let builder = if account.username.trim().is_empty() {
        builder
    } else {
        builder.credentials(Credentials::new(
            account.username.clone(),
            password.to_string(),
        ))
    };

    Ok(builder.build())
}

/// Turn an SMTP error into something that points at the likely cause.
///
/// The raw errors are accurate and useless: "permanent error (535)" is not a
/// thing anyone can act on, whereas "your provider rejected the password" is.
fn enrich(error: lettre::transport::smtp::Error, account: &Account) -> anyhow::Error {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();

    if lower.contains("535") || lower.contains("authentication") || lower.contains("username") {
        return anyhow::anyhow!(
            "{} rejected the username or password. \
             Gmail, Outlook and Yahoo all need an app password here rather than \
             your normal one, which means two-factor sign-in has to be on. ({text})",
            account.host
        );
    }
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake") {
        return anyhow::anyhow!(
            "could not negotiate encryption with {}:{}. \
             Port 587 usually wants STARTTLS and port 465 wants TLS; \
             they are not interchangeable. ({text})",
            account.host,
            account.port
        );
    }
    if lower.contains("timed out") || lower.contains("connection") || lower.contains("dns") {
        return anyhow::anyhow!(
            "could not reach {}:{}. Check the server name and port. ({text})",
            account.host,
            account.port
        );
    }
    anyhow::anyhow!("{text}")
}

/// The media type a device uses to decide whether it can open the attachment.
///
/// A Kindle ignores an `application/octet-stream` it would otherwise accept, so
/// this is not cosmetic.
fn mime_for(filename: &str) -> &'static str {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "epub" => "application/epub+zip",
        "cbz" => "application/vnd.comicbook+zip",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn content_type(filename: &str) -> ContentType {
    ContentType::parse(mime_for(filename)).unwrap_or(ContentType::TEXT_PLAIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_inflates_by_about_a_third() {
        // 3 MB of file is roughly 4 MB on the wire, which is the whole reason a
        // 30 MB volume does not fit a 25 MB attachment limit.
        let encoded = encoded_size(3 * 1024 * 1024);
        assert!(encoded > 4_000_000 && encoded < 4_300_000, "{encoded}");
    }

    #[test]
    fn a_small_volume_has_no_size_problem() {
        assert!(size_problem(5 * 1024 * 1024).is_none());
    }

    #[test]
    fn a_volume_over_the_provider_limit_names_that_limit() {
        let problem = size_problem(30 * 1024 * 1024).expect("30 MB should be flagged");
        assert!(problem.contains("25 MB"), "{problem}");
        assert!(problem.contains("Gmail"), "{problem}");
    }

    #[test]
    fn a_volume_over_amazons_limit_says_so_instead() {
        let problem = size_problem(45 * 1024 * 1024).expect("45 MB should be flagged");
        assert!(problem.contains("50 MB"), "{problem}");
        assert!(problem.contains("USB"), "should suggest the way out: {problem}");
    }

    #[test]
    fn attachments_are_typed_so_a_kindle_recognises_them() {
        assert_eq!(mime_for("Ichi v01.epub"), "application/epub+zip");
        assert_eq!(mime_for("Ichi v01.cbz"), "application/vnd.comicbook+zip");
        assert_eq!(mime_for("Ichi v01.EPUB"), "application/epub+zip");
        assert_eq!(mime_for("noextension"), "application/octet-stream");
        // And the parse the sender actually uses must accept them.
        assert!(ContentType::parse(mime_for("v01.epub")).is_ok());
        assert!(ContentType::parse(mime_for("v01.cbz")).is_ok());
    }

    #[test]
    fn a_missing_address_is_refused_before_any_connection() {
        let account = Account {
            host: "smtp.example.test".into(),
            port: 587,
            security: Security::StartTls,
            username: "me".into(),
            from: "me@example.test".into(),
        };
        let error = send(
            &account,
            "pw",
            &Delivery { to: "  ", filename: "v01.epub", bytes: vec![1, 2, 3] },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("device address"), "{error}");
    }
}
