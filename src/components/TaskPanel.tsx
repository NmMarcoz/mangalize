import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  PackageCheck,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: number;
  kind: string;
  title: string;
  detail: string;
  done: number;
  total: number;
  state: TaskState;
  error: string | null;
  summary: string | null;
}

export const tasksList = () => invoke<Task[]>("tasks_list");
export const cancelTask = (id: number) => invoke<void>("task_cancel", { id });
export const clearFinishedTasks = () => invoke<void>("tasks_clear_finished");

/** Still going, or waiting to. What the badge counts. */
export const isActive = (task: Task) =>
  task.state === "queued" || task.state === "running";

/**
 * Everything the app is doing, and everything it has just done.
 *
 * The queue is the point: downloads run one at a time against a single host, so
 * what is waiting and what is in progress is a real ordering rather than a pile.
 * Finished rows stay until cleared, because "did that actually work" is asked
 * after the fact far more often than during.
 */
export function TaskPanel({
  tasks,
  onClose,
}: {
  tasks: Task[];
  onClose: () => void;
}) {
  const finished = tasks.filter((t) => !isActive(t));

  return (
    <aside className="absolute right-3 top-14 z-40 flex max-h-[70dvh] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-xs font-semibold">Tasks</h2>
        {finished.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void clearFinishedTasks()}>
            Clear finished
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X className="size-3" />
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            Nothing running. Downloads and builds appear here, and carry on while
            you read.
          </p>
        ) : (
          tasks.map((task) => <Row key={task.id} task={task} />)
        )}
      </div>
    </aside>
  );
}

function Row({ task }: { task: Task }) {
  const running = task.state === "running";

  return (
    <div className="flex items-start gap-2.5 border-b border-border/50 px-3 py-2 last:border-b-0">
      <span className="mt-0.5 shrink-0">
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : task.state === "done" ? (
          <Check className="size-3.5 text-primary" />
        ) : task.state === "failed" ? (
          <AlertTriangle className="size-3.5 text-destructive" />
        ) : task.state === "cancelled" ? (
          <X className="size-3.5 text-muted-foreground" />
        ) : task.kind === "build" ? (
          <PackageCheck className="size-3.5 text-muted-foreground" />
        ) : (
          <Download className="size-3.5 text-muted-foreground" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{task.title}</p>
        <p
          className={cn(
            "truncate text-[11px]",
            task.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
          title={task.error ?? undefined}
        >
          {task.error ??
            task.summary ??
            (task.state === "queued"
              ? "waiting"
              : task.state === "cancelled"
                ? "stopped"
                : task.detail)}
        </p>

        {running && task.total > 0 && (
          <div className="mt-1 flex items-center gap-2">
            <Progress value={(task.done / task.total) * 100} className="h-1 flex-1" />
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {task.done}/{task.total}
            </span>
          </div>
        )}
      </div>

      {isActive(task) && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Stop"
          onClick={() => void cancelTask(task.id)}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * The task list, kept in step with the backend.
 *
 * Lives here rather than in a view because the queue outlives every screen —
 * that is the whole point of it — and the badge has to be right wherever you are.
 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);

  const refresh = useCallback(() => {
    tasksList()
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const pending = listen<Task[]>("tasks-changed", (e) => setTasks(e.payload));
    return () => {
      void pending.then((fn) => fn());
    };
  }, [refresh]);

  return { tasks, active: tasks.filter(isActive).length, refresh };
}
