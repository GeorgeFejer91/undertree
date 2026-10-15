//! Bounded stderr bytes for one stream. Keep this state outside the owner's timed future.
//! EOF is a read observation, not proof of process completion or native provenance.
use super::MAX_DIAGNOSTICS;
use crate::{Error, Result};
use tokio::io::{AsyncRead, AsyncReadExt};

pub(super) struct StderrCapture {
    bytes: Vec<u8>,
    eof: bool,
    clipped: bool,
    read_failed: bool,
}

impl StderrCapture {
    pub(super) fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(MAX_DIAGNOSTICS + 1),
            eof: false,
            clipped: false,
            read_failed: false,
        }
    }

    pub(super) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(super) fn eof(&self) -> bool {
        self.eof
    }

    pub(super) fn clipped(&self) -> bool {
        self.clipped
    }

    pub(super) fn read_failed(&self) -> bool {
        self.read_failed
    }

    /// A cancelled read may resume the same stream; terminal observations never reset.
    pub(super) async fn read(&mut self, reader: &mut (impl AsyncRead + Unpin)) -> Result<()> {
        let limit = || {
            Error::new(
                "limit",
                "Typst diagnostics exceeded 64 KB. The last good PDF is preserved.",
            )
        };
        if self.clipped {
            return Err(limit());
        }
        if self.read_failed {
            return Err(std::io::Error::from(std::io::ErrorKind::Other).into());
        }
        if self.eof {
            return Ok(());
        }
        let mut chunk = [0; 8192];
        loop {
            let maximum = (MAX_DIAGNOSTICS + 1 - self.bytes.len()).min(chunk.len());
            let count = match reader.read(&mut chunk[..maximum]).await {
                Ok(count) => count,
                Err(error) => {
                    self.read_failed = true;
                    return Err(error.into());
                }
            };
            if count == 0 {
                self.eof = true;
                return Ok(());
            }
            self.bytes.extend_from_slice(&chunk[..count]);
            if self.bytes.len() > MAX_DIAGNOSTICS {
                self.clipped = true;
                return Err(limit());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncWriteExt, ReadBuf};

    struct MustNotRead;

    impl AsyncRead for MustNotRead {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            panic!("a terminal capture must not poll another reader");
        }
    }

    async fn pending_once(future: Pin<&mut impl Future>) {
        let mut future = future;
        std::future::poll_fn(|context| {
            assert!(future.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    #[tokio::test]
    async fn empty_duplex_eof_is_observed_and_terminal() {
        let (writer, mut reader) = duplex(8);
        drop(writer);
        let mut capture = StderrCapture::new();
        capture.read(&mut reader).await.unwrap();
        assert_eq!(capture.bytes(), b"");
        assert!(capture.eof());
        assert!(!capture.clipped() && !capture.read_failed());
        capture.read(&mut MustNotRead).await.unwrap();
        assert!(capture.eof());
    }

    #[tokio::test]
    async fn below_cap_duplex_preserves_exact_chunked_raw_bytes_before_eof() {
        let expected = b"main.typ:1:0: error: raw \xff\r\n\xf0\x9f\x92\x9b";
        let (mut writer, mut reader) = duplex(3);
        let write = tokio::spawn(async move {
            for part in expected.chunks(2) {
                writer.write_all(part).await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });
        let mut capture = StderrCapture::new();
        capture.read(&mut reader).await.unwrap();
        write.await.unwrap();
        assert_eq!(capture.bytes(), expected);
        assert!(capture.eof());
        assert!(!capture.clipped() && !capture.read_failed());
        assert!(capture.bytes.capacity() <= MAX_DIAGNOSTICS + 1);
    }

    #[tokio::test]
    async fn exact_cap_requires_actual_eof_instead_of_treating_the_limit_as_eof() {
        let expected = vec![b'x'; MAX_DIAGNOSTICS];
        let (mut writer, mut reader) = duplex(MAX_DIAGNOSTICS);
        writer.write_all(&expected).await.unwrap();
        let mut capture = StderrCapture::new();
        let mut reading = Box::pin(capture.read(&mut reader));
        pending_once(reading.as_mut()).await;
        drop(reading);
        assert_eq!(capture.bytes(), expected);
        assert!(!capture.eof() && !capture.clipped() && !capture.read_failed());
        writer.shutdown().await.unwrap();
        capture.read(&mut reader).await.unwrap();
        assert!(capture.eof());
        assert!(!capture.clipped() && !capture.read_failed());
    }

    #[tokio::test]
    async fn overflow_keeps_one_sentinel_stops_reading_and_cannot_be_untruncated() {
        let mut input = vec![b'x'; MAX_DIAGNOSTICS];
        input.push(0xfe);
        input.extend_from_slice(b"unconsumed tail");
        let (mut writer, mut reader) = duplex(input.len());
        writer.write_all(&input).await.unwrap();
        let mut capture = StderrCapture::new();
        let error = tokio::time::timeout(Duration::from_secs(5), capture.read(&mut reader))
            .await
            .expect("capture must stop at the overflow sentinel without draining the open stream")
            .unwrap_err();
        assert_eq!(error.code, "limit");
        assert_eq!(capture.bytes(), &input[..MAX_DIAGNOSTICS + 1]);
        assert_eq!(capture.bytes().last(), Some(&0xfe));
        assert!(capture.clipped());
        assert!(!capture.eof() && !capture.read_failed());
        assert!(capture.bytes.capacity() <= MAX_DIAGNOSTICS + 1);
        assert_eq!(
            capture.read(&mut MustNotRead).await.unwrap_err().code,
            "limit"
        );
        assert_eq!(capture.bytes(), &input[..MAX_DIAGNOSTICS + 1]);
        assert!(capture.clipped() && !capture.eof());
        writer.shutdown().await.unwrap();
        let mut remainder = Vec::new();
        reader.read_to_end(&mut remainder).await.unwrap();
        assert_eq!(remainder, b"unconsumed tail");
    }

    #[tokio::test]
    async fn timeout_keeps_outer_empty_or_confirmed_prefix_without_false_eof() {
        for prefix in [b"".as_slice(), b"confirmed diagnostic prefix\n"] {
            let (mut writer, mut reader) = duplex(64);
            writer.write_all(prefix).await.unwrap();
            let mut capture = StderrCapture::new();
            let mut reading = Box::pin(capture.read(&mut reader));
            pending_once(reading.as_mut()).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(10), reading.as_mut())
                    .await
                    .is_err()
            );
            drop(reading);
            assert_eq!(capture.bytes(), prefix);
            assert!(!capture.eof() && !capture.clipped() && !capture.read_failed());
            writer.write_all(b"after cancellation").await.unwrap();
            writer.shutdown().await.unwrap();
            capture.read(&mut reader).await.unwrap();
            let mut expected = prefix.to_vec();
            expected.extend_from_slice(b"after cancellation");
            assert_eq!(capture.bytes(), expected);
            assert!(capture.eof());
        }
    }

    #[tokio::test]
    async fn dropped_read_future_retains_confirmed_prefix_with_open_peer() {
        let (mut writer, mut reader) = duplex(64);
        writer.write_all(b"confirmed prefix\0\xff").await.unwrap();
        let mut capture = StderrCapture::new();
        let mut reading = Box::pin(capture.read(&mut reader));
        pending_once(reading.as_mut()).await;
        drop(reading);
        assert_eq!(capture.bytes(), b"confirmed prefix\0\xff");
        assert!(!capture.eof() && !capture.clipped() && !capture.read_failed());
        writer.shutdown().await.unwrap();
        capture.read(&mut reader).await.unwrap();
        assert_eq!(capture.bytes(), b"confirmed prefix\0\xff");
        assert!(capture.eof());
    }

    struct ErrorAfterPrefix {
        prefix: &'static [u8],
        offset: usize,
    }

    impl AsyncRead for ErrorAfterPrefix {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.offset == self.prefix.len() {
                return Poll::Ready(Err(std::io::Error::other("private test reader failure")));
            }
            let count = buffer.remaining().min(self.prefix.len() - self.offset);
            buffer.put_slice(&self.prefix[self.offset..self.offset + count]);
            self.offset += count;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn read_failure_retains_prefix_and_cannot_be_replaced_by_later_eof() {
        let mut reader = ErrorAfterPrefix {
            prefix: b"confirmed before error\0\xff",
            offset: 0,
        };
        let mut capture = StderrCapture::new();
        let error = capture.read(&mut reader).await.unwrap_err();
        assert_eq!(error.code, "io");
        assert!(!error.message.contains("private test"));
        assert_eq!(capture.bytes(), reader.prefix);
        assert!(capture.read_failed());
        assert!(!capture.eof() && !capture.clipped());
        assert_eq!(capture.read(&mut MustNotRead).await.unwrap_err().code, "io");
        assert_eq!(capture.bytes(), reader.prefix);
        assert!(capture.read_failed() && !capture.eof());
    }
}
