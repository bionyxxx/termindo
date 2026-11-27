//! A connect timeout that stops counting while the user is answering a prompt.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

use crate::client::{BoxFuture, HostKeyInfo, Interaction, KbdRequest};

/// Forwards to `inner` and publishes how many prompts are waiting for an answer.
///
/// With jump hosts these wrappers nest, so a prompt from a jump host also pauses the
/// timeout of every connection that depends on it.
struct Tracked {
    inner: Arc<dyn Interaction>,
    open: watch::Sender<usize>,
}

/// Wrap `inner` for use with [`timeout`].
pub(crate) fn track(inner: Arc<dyn Interaction>) -> (Arc<dyn Interaction>, watch::Receiver<usize>) {
    let (open, waiting) = watch::channel(0);
    (Arc::new(Tracked { inner, open }), waiting)
}

/// Counts one open prompt until dropped, including when the prompt future is cancelled.
struct OpenPrompt<'a>(&'a watch::Sender<usize>);

impl<'a> OpenPrompt<'a> {
    fn new(open: &'a watch::Sender<usize>) -> Self {
        open.send_modify(|n| *n += 1);
        Self(open)
    }
}

impl Drop for OpenPrompt<'_> {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

impl Interaction for Tracked {
    fn verify_host_key(&self, info: HostKeyInfo) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let _open = OpenPrompt::new(&self.open);
            self.inner.verify_host_key(info).await
        })
    }

    fn keyboard_interactive(&self, req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move {
            let _open = OpenPrompt::new(&self.open);
            self.inner.keyboard_interactive(req).await
        })
    }

    fn banner(&self, host: &str, banner: &str) {
        self.inner.banner(host, banner);
    }
}

/// Run `fut`, giving up with `None` once it has spent `limit` while no prompt was open.
///
/// `fut` must keep the sender behind `waiting` alive until it completes.
pub(crate) async fn timeout<F: Future>(
    limit: Duration,
    mut waiting: watch::Receiver<usize>,
    fut: F,
) -> Option<F::Output> {
    tokio::pin!(fut);
    let mut left = limit;
    loop {
        let paused = *waiting.borrow_and_update() > 0;
        let started = Instant::now();
        tokio::select! {
            biased;
            out = &mut fut => return Some(out),
            Ok(()) = waiting.changed() => {}
            () = tokio::time::sleep(left), if !paused => return None,
        }
        if !paused {
            left = left.saturating_sub(started.elapsed());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Slow(Duration);

    impl Interaction for Slow {
        fn verify_host_key(&self, _info: HostKeyInfo) -> BoxFuture<'_, bool> {
            Box::pin(async { true })
        }
        fn keyboard_interactive(&self, _req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>> {
            Box::pin(async {
                tokio::time::sleep(self.0).await;
                Some(Vec::new())
            })
        }
    }

    const LIMIT: Duration = Duration::from_secs(15);

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn request() -> KbdRequest {
        KbdRequest {
            host: "h".into(),
            name: String::new(),
            instructions: String::new(),
            prompts: Vec::new(),
        }
    }

    /// Network work, then a prompt answered after `answer`, then more network work.
    async fn run(before: Duration, answer: Duration, after: Duration) -> bool {
        let (ui, waiting) = track(Arc::new(Slow(answer)));
        timeout(LIMIT, waiting, async move {
            tokio::time::sleep(before).await;
            ui.keyboard_interactive(request()).await;
            tokio::time::sleep(after).await;
        })
        .await
        .is_some()
    }

    #[tokio::test(start_paused = true)]
    async fn prompt_time_is_not_counted() {
        assert!(run(secs(7), secs(600), secs(7)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn time_around_a_prompt_adds_up() {
        assert!(!run(secs(8), secs(600), secs(8)).await);
        assert!(!run(secs(16), secs(0), secs(0)).await);
        assert!(!run(secs(0), secs(0), secs(16)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn nested_prompt_pauses_outer_timeout() {
        let (outer, waiting) = track(Arc::new(Slow(secs(600))));
        let done = timeout(LIMIT, waiting, async move {
            let (inner, inner_waiting) = track(outer.clone());
            timeout(LIMIT, inner_waiting, inner.keyboard_interactive(request())).await
        })
        .await;
        assert!(matches!(done, Some(Some(Some(_)))));
    }
}
