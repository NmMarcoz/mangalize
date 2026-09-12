//! End-to-end against a real SMTP conversation on a local socket.
//!
//! Everything that goes wrong with sending a volume goes wrong at the protocol
//! layer — the wrong envelope, an attachment that never got encoded, a filename
//! the device will not recognise. A mocked transport would assert none of it, so
//! this speaks actual SMTP to a listener and then reads what arrived.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver};

use mangalize_send::{send, send_test, Account, Delivery, Security};

/// What the server saw.
struct Received {
    mail_from: String,
    rcpt_to: String,
    data: String,
}

/// A one-shot SMTP server. Accepts a single message and reports it back.
fn server() -> (u16, Receiver<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();

    std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            if let Ok(received) = converse(stream) {
                let _ = tx.send(received);
            }
        }
    });

    (port, rx)
}

fn converse(mut stream: TcpStream) -> std::io::Result<Received> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut received = Received {
        mail_from: String::new(),
        rcpt_to: String::new(),
        data: String::new(),
    };

    stream.write_all(b"220 localhost ESMTP\r\n")?;

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let upper = line.trim_end().to_ascii_uppercase();

        if upper.starts_with("EHLO") || upper.starts_with("HELO") {
            // Advertising AUTH is what makes lettre authenticate at all, which
            // is half of what this test is here to exercise.
            stream.write_all(b"250-localhost\r\n250-SIZE 104857600\r\n250 AUTH PLAIN LOGIN\r\n")?;
        } else if upper.starts_with("AUTH PLAIN") {
            stream.write_all(b"235 2.7.0 Authentication successful\r\n")?;
        } else if upper.starts_with("AUTH LOGIN") {
            // Username then password, each its own base64 challenge.
            stream.write_all(b"334 VXNlcm5hbWU6\r\n")?;
            let mut discard = String::new();
            reader.read_line(&mut discard)?;
            stream.write_all(b"334 UGFzc3dvcmQ6\r\n")?;
            discard.clear();
            reader.read_line(&mut discard)?;
            stream.write_all(b"235 2.7.0 Authentication successful\r\n")?;
        } else if upper.starts_with("MAIL FROM") {
            received.mail_from = line.trim_end().to_string();
            stream.write_all(b"250 2.1.0 Ok\r\n")?;
        } else if upper.starts_with("RCPT TO") {
            received.rcpt_to = line.trim_end().to_string();
            stream.write_all(b"250 2.1.5 Ok\r\n")?;
        } else if upper.starts_with("DATA") {
            stream.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n")?;
            loop {
                let mut body = String::new();
                if reader.read_line(&mut body)? == 0 {
                    break;
                }
                if body.trim_end() == "." {
                    break;
                }
                received.data.push_str(&body);
            }
            stream.write_all(b"250 2.0.0 Ok: queued\r\n")?;
        } else if upper.starts_with("QUIT") {
            stream.write_all(b"221 2.0.0 Bye\r\n")?;
            break;
        } else {
            stream.write_all(b"250 2.0.0 Ok\r\n")?;
        }
    }

    Ok(received)
}

fn account(port: u16) -> Account {
    Account {
        host: "127.0.0.1".into(),
        port,
        // The local listener speaks plain SMTP; TLS is exercised by the config,
        // not by this fixture.
        security: Security::None,
        username: "reader".into(),
        from: "reader@example.test".into(),
    }
}

#[test]
fn a_volume_arrives_addressed_and_attached() {
    let (port, rx) = server();

    // Every byte value, so the payload is unambiguously binary — a short,
    // mostly-printable stand-in gets quoted-printable instead of base64 and
    // proves much less.
    let bytes: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
    send(
        &account(port),
        "app-password",
        &Delivery {
            to: "reader@kindle.com",
            filename: "Ichi the Witch v01.epub",
            bytes: bytes.clone(),
        },
    )
    .expect("send should succeed against a well-behaved server");

    let got = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();

    // The envelope, which is what actually routes the mail.
    assert!(got.mail_from.contains("reader@example.test"), "{}", got.mail_from);
    assert!(got.rcpt_to.contains("reader@kindle.com"), "{}", got.rcpt_to);

    // Amazon titles the document from the attachment's filename, so it has to
    // survive intact — spaces and all.
    assert!(
        got.data.contains("Ichi the Witch v01.epub"),
        "filename missing from the message"
    );
    assert!(
        got.data.contains("application/epub+zip"),
        "a Kindle ignores an attachment it cannot type"
    );
    assert!(
        got.data.contains("Content-Transfer-Encoding"),
        "the attachment must declare a transfer encoding"
    );

    // The point of the whole exercise: the file has to arrive byte for byte.
    // A silently mangled attachment is a corrupt volume on the device.
    let delivered = decode_attachment(&got.data);
    assert_eq!(delivered.len(), bytes.len(), "attachment changed size in transit");
    assert_eq!(delivered, bytes, "attachment did not survive intact");
}

/// Pull the attachment part out of a MIME message and decode it.
fn decode_attachment(data: &str) -> Vec<u8> {
    use base64::Engine;

    let part = data
        .split("--")
        .find(|section| section.contains("application/epub+zip"))
        .expect("no attachment part in the message");

    // Headers, a blank line, then the payload.
    let body = part
        .split_once("\r\n\r\n")
        .or_else(|| part.split_once("\n\n"))
        .expect("attachment part has no body")
        .1;

    let encoded: String = body.split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim_end_matches('-'))
        .expect("attachment was not valid base64")
}

#[test]
fn the_test_message_carries_no_attachment() {
    let (port, rx) = server();

    send_test(&account(port), "app-password", "reader@kindle.com")
        .expect("test message should send");

    let got = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    assert!(got.rcpt_to.contains("reader@kindle.com"));
    assert!(!got.data.contains("application/epub+zip"));
    // It should say the one thing that is worth saying when it does not arrive.
    assert!(got.data.contains("Approved Personal Document"));
}

#[test]
fn an_unreachable_server_says_so_rather_than_leaking_smtp_jargon() {
    // Nothing is listening on this port.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let error = send(
        &account(port),
        "app-password",
        &Delivery { to: "reader@kindle.com", filename: "v01.epub", bytes: vec![1, 2, 3] },
    )
    .unwrap_err()
    .to_string();

    assert!(
        error.contains("could not reach") && error.contains("127.0.0.1"),
        "unhelpful error: {error}"
    );
}

#[test]
fn a_volume_too_large_to_arrive_is_refused_before_dialling_out() {
    // No server at all: the size check must happen before any connection, or a
    // 40 MB upload gets thrown away by the provider after the wait.
    let error = send(
        &Account { host: "127.0.0.1".into(), port: 1, ..account(1) },
        "app-password",
        &Delivery {
            to: "reader@kindle.com",
            filename: "huge.epub",
            bytes: vec![0u8; 30 * 1024 * 1024],
        },
    )
    .unwrap_err()
    .to_string();

    assert!(error.contains("25 MB"), "should name the limit it hit: {error}");
}
