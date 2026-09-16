//! Long jobs that run whether or not anyone is watching.
//!
//! Downloading a run of chapters or writing a volume takes minutes, and until
//! now the dialog that started one *was* the job: closing it was not an option,
//! and the app was unusable in the meantime. A queue fixes both — the work is
//! handed over, the caller returns immediately, and what is happening is a
//! question you can ask rather than a screen you are held on.
//!
//! One worker, not a pool. Everything queued here talks to a single host, which
//! is exactly what the per-chapter pause in `fetch.rs` is being polite about;
//! running four downloads at once would undo that. It also means the queue is a
//! queue rather than a heap, which is what makes it worth showing.
//!
//! Cancellation is per task, not global: stopping the download you just started
//! must not stop the one you queued ten minutes ago.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted whenever any task changes. Carries the whole list: it is a handful
/// of small rows, and a diff would be more to get wrong than to send.
const CHANGED: &str = "tasks-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl TaskState {
    fn settled(self) -> bool {
        matches!(self, TaskState::Done | TaskState::Failed | TaskState::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: u64,
    /// What this is, for grouping and for the icon: `download` or `build`.
    pub kind: String,
    /// Which series or volume, so a queue of five is readable.
    pub title: String,
    /// The step in progress, e.g. `chapter 7` or `downloading`.
    pub detail: String,
    pub done: u32,
    pub total: u32,
    pub state: TaskState,
    /// Why it failed, verbatim. `None` unless `state` is `failed`.
    pub error: Option<String>,
    /// How far a partly-finished run got, kept after it settles.
    pub summary: Option<String>,
}

/// The handle a running job uses to report on itself.
///
/// Deliberately the only thing a job is given: it can say what it is doing and
/// ask whether it should stop, and it cannot reach the queue or the other tasks.
pub struct Progress<R: Runtime> {
    app: AppHandle<R>,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl<R: Runtime> Progress<R> {
    /// Has this task been asked to stop? Long jobs should check between items.
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn step(&self, detail: impl Into<String>, done: u32, total: u32) {
        let detail = detail.into();
        update(&self.app, self.id, |task| {
            task.detail = detail.clone();
            task.done = done;
            task.total = total;
        });
    }
}

#[derive(Default)]
struct Registry {
    tasks: Vec<Task>,
    cancels: Vec<(u64, Arc<AtomicBool>)>,
}

/// The queue. One worker thread, started on first use.
pub struct Queue {
    next_id: AtomicU64,
    registry: Mutex<Registry>,
    sender: Mutex<Option<mpsc::Sender<Job>>>,
}

type Job = Box<dyn FnOnce() + Send>;

impl Default for Queue {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            registry: Mutex::new(Registry::default()),
            sender: Mutex::new(None),
        }
    }
}

/// Put a job on the queue and return its task id straight away.
///
/// The closure is handed a [`Progress`] and runs on the worker thread. Whatever
/// it returns as an error becomes the task's failure message; a `Some(summary)`
/// is kept and shown after it finishes, which is how a run that downloaded
/// eleven of twelve chapters says so.
pub fn enqueue<R, F>(app: &AppHandle<R>, kind: &str, title: &str, work: F) -> u64
where
    R: Runtime,
    F: FnOnce(&Progress<R>) -> anyhow::Result<Option<String>> + Send + 'static,
{
    let queue = app.state::<Queue>();
    let id = queue.next_id.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut registry = queue.registry.lock().expect("task registry");
        registry.tasks.push(Task {
            id,
            kind: kind.to_string(),
            title: title.to_string(),
            detail: "waiting".into(),
            done: 0,
            total: 0,
            state: TaskState::Queued,
            error: None,
            summary: None,
        });
        registry.cancels.push((id, Arc::clone(&cancel)));
    }
    broadcast(app);

    let handle = app.clone();
    let job: Job = Box::new(move || {
        // Cancelled while it was still waiting: never start it.
        if cancel.load(Ordering::Relaxed) {
            update(&handle, id, |task| task.state = TaskState::Cancelled);
            return;
        }

        update(&handle, id, |task| {
            task.state = TaskState::Running;
            task.detail = "starting".into();
        });

        let progress = Progress {
            app: handle.clone(),
            id,
            cancel: Arc::clone(&cancel),
        };
        let outcome = work(&progress);
        let stopped = cancel.load(Ordering::Relaxed);

        update(&handle, id, |task| {
            match &outcome {
                Ok(summary) => {
                    task.summary = summary.clone();
                    // A job that noticed the cancel and returned tidily still
                    // stopped early, and saying "done" would be a lie.
                    task.state = if stopped { TaskState::Cancelled } else { TaskState::Done };
                }
                Err(e) => {
                    task.error = Some(format!("{e:#}"));
                    task.state = TaskState::Failed;
                }
            }
            task.detail = String::new();
        });
    });

    send(app, job);
    id
}

/// Hand a job to the worker, starting it the first time.
fn send<R: Runtime>(app: &AppHandle<R>, job: Job) {
    let queue = app.state::<Queue>();
    let mut sender = queue.sender.lock().expect("task sender");
    if sender.is_none() {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("mangalize-tasks".into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .expect("spawning the task worker");
        *sender = Some(tx);
    }
    // Only fails if the worker died, which it cannot do while the channel lives.
    let _ = sender.as_ref().expect("task sender").send(job);
}

fn update<R: Runtime>(app: &AppHandle<R>, id: u64, change: impl FnOnce(&mut Task)) {
    {
        let queue = app.state::<Queue>();
        let mut registry = queue.registry.lock().expect("task registry");
        let Some(task) = registry.tasks.iter_mut().find(|t| t.id == id) else {
            return;
        };
        change(task);
    }
    broadcast(app);
}

fn broadcast<R: Runtime>(app: &AppHandle<R>) {
    let snapshot = {
        let queue = app.state::<Queue>();
        let registry = queue.registry.lock().expect("task registry");
        registry.tasks.clone()
    };
    let _ = app.emit(CHANGED, snapshot);
}

/* ------------------------------------------------------------------ commands */

#[tauri::command]
pub fn tasks_list(queue: tauri::State<Queue>) -> Vec<Task> {
    queue.registry.lock().expect("task registry").tasks.clone()
}

/// Ask a task to stop. It stops between items, not mid-write.
#[tauri::command]
pub fn task_cancel(app: AppHandle, id: u64) {
    {
        let queue = app.state::<Queue>();
        let registry = queue.registry.lock().expect("task registry");
        if let Some((_, flag)) = registry.cancels.iter().find(|(task, _)| *task == id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Shown as stopping straight away; a job mid-chapter may take a moment.
    update(&app, id, |task| {
        if task.state == TaskState::Running {
            task.detail = "stopping".into();
        }
    });
}

/// Drop everything that has finished, one way or another.
#[tauri::command]
pub fn tasks_clear_finished(app: AppHandle) {
    {
        let queue = app.state::<Queue>();
        let mut registry = queue.registry.lock().expect("task registry");
        let keep: Vec<u64> = registry
            .tasks
            .iter()
            .filter(|t| !t.state.settled())
            .map(|t| t.id)
            .collect();
        registry.tasks.retain(|t| keep.contains(&t.id));
        registry.cancels.retain(|(id, _)| keep.contains(id));
    }
    broadcast(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settled_task_is_one_nothing_more_will_happen_to() {
        assert!(TaskState::Done.settled());
        assert!(TaskState::Failed.settled());
        assert!(TaskState::Cancelled.settled());
        assert!(!TaskState::Queued.settled());
        assert!(
            !TaskState::Running.settled(),
            "clearing finished tasks must never drop one still working"
        );
    }
}
