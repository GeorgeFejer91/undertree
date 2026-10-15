//! One compiler PDF stream into its held private file. Never write the overflow sentinel.
use super::MAX_PDF;
use crate::{Error, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// The owner retains `output` outside cancellation and flushes it before cleanup on failure.
/// Success requires actual EOF and completion of pending file writes, not a full quota.
pub(super) async fn spool(
    reader: &mut (impl AsyncRead + Unpin),
    output: &mut tokio::fs::File,
) -> Result<()> {
    let mut written = 0;
    let mut chunk = [0; 8192];
    loop {
        let remaining = MAX_PDF - written;
        let maximum = (remaining + 1).min(chunk.len());
        let count = reader.read(&mut chunk[..maximum]).await?;
        if count == 0 {
            output.flush().await?;
            return Ok(());
        }
        let admitted = count.min(remaining);
        output.write_all(&chunk[..admitted]).await?;
        written += admitted;
        if admitted != count {
            return Err(Error::new(
                "limit",
                "Typst PDF exceeded 16 MiB. The last good PDF is preserved.",
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{duplex, ReadBuf};

    fn output() -> (tempfile::NamedTempFile, tokio::fs::File) {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let output = tokio::fs::File::from_std(temporary.as_file().try_clone().unwrap());
        (temporary, output)
    }

    #[tokio::test]
    async fn empty_below_exact_and_over_cap_write_only_exact_admitted_bytes() {
        for length in [0, 17, MAX_PDF, MAX_PDF + 1] {
            let (temporary, mut output) = output();
            let mut input = std::io::Cursor::new(vec![0xa5; length]);
            let result = spool(&mut input, &mut output).await;
            output.flush().await.unwrap();
            if length > MAX_PDF {
                assert_eq!(result.unwrap_err().code, "limit");
            } else {
                result.unwrap();
            }
            assert_eq!(input.position(), length as u64);
            assert_eq!(
                std::fs::read(temporary.path()).unwrap(),
                vec![0xa5; length.min(MAX_PDF)]
            );
        }
    }

    #[tokio::test]
    async fn sentinel_is_never_written_and_overflow_does_not_drain_the_tail() {
        let (temporary, mut output) = output();
        let mut bytes = vec![b'x'; MAX_PDF];
        bytes.extend_from_slice(b"!unconsumed tail");
        let mut input = std::io::Cursor::new(bytes);
        assert_eq!(
            spool(&mut input, &mut output).await.unwrap_err().code,
            "limit"
        );
        output.flush().await.unwrap();
        assert_eq!(input.position(), MAX_PDF as u64 + 1);
        assert_eq!(
            temporary.as_file().metadata().unwrap().len(),
            MAX_PDF as u64
        );
        let mut tail = Vec::new();
        input.read_to_end(&mut tail).await.unwrap();
        assert_eq!(tail, b"unconsumed tail");
    }

    #[tokio::test]
    async fn open_exact_cap_requires_eof_and_cancelled_file_remains_owned() {
        let (temporary, mut output) = output();
        let (mut writer, mut reader) = duplex(MAX_PDF);
        writer.write_all(&vec![b'x'; MAX_PDF]).await.unwrap();
        let mut reading = Box::pin(spool(&mut reader, &mut output));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::select! {
                result = reading.as_mut() => panic!("an open exact-cap pipe must not finish: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
            if temporary.as_file().metadata().unwrap().len() == MAX_PDF as u64 {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(10), reading.as_mut())
                .await
                .is_err()
        );
        drop(reading);
        // The owner can finish pending filesystem work after the read future is cancelled.
        output.flush().await.unwrap();
        assert_eq!(
            temporary.as_file().metadata().unwrap().len(),
            MAX_PDF as u64
        );
        drop(writer);
        let mut sentinel = [0; 1];
        assert_eq!(reader.read(&mut sentinel).await.unwrap(), 0);
    }

    struct ErrorAfterPrefix(bool);

    impl AsyncRead for ErrorAfterPrefix {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.0 {
                return Poll::Ready(Err(std::io::Error::other("private synthetic read error")));
            }
            self.0 = true;
            buffer.put_slice(b"%PDF-prefix");
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn read_or_file_write_failure_cannot_report_success() {
        let (temporary, mut output) = output();
        let error = spool(&mut ErrorAfterPrefix(false), &mut output)
            .await
            .unwrap_err();
        assert_eq!(error.code, "io");
        assert!(!error.message.contains("private synthetic"));
        output.flush().await.unwrap();
        assert_eq!(std::fs::read(temporary.path()).unwrap(), b"%PDF-prefix");
        let mut read_only =
            tokio::fs::File::from_std(std::fs::File::open(temporary.path()).unwrap());
        assert_eq!(
            spool(&mut std::io::Cursor::new(b"cannot write"), &mut read_only)
                .await
                .unwrap_err()
                .code,
            "io"
        );
    }
}
