// TaskBridge state machine, persistence seam, and restart recovery with a fake DSH port.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryTaskStore,
  TASK_TRANSITIONS,
  TaskBridge,
  TaskTransitionError,
  canTransition,
  type DshTaskPort,
  type TaskRequest,
  type TaskStatus,
  type TaskStatusKind,
} from "../../packages/dsh-bridge/src/index.ts";

const request: TaskRequest = {
  character_id: "default",
  user_input: "hello",
  artifacts_needed: ["text"],
};

const ALL: TaskStatusKind[] = [
  "queued", "running", "waiting_user", "waiting_approval", "waiting_quota",
  "waiting_external", "succeeded", "failed", "cancelled", "interrupted",
];

function fakePort() {
  const calls: string[] = [];
  let next = 0;
  const port: DshTaskPort = {
    async createSession() {
      next += 1;
      calls.push(`create:s-${next}`);
      return `s-${next}`;
    },
    async send(session_id, text) {
      calls.push(`send:${session_id}:${text}`);
    },
    async cancel(session_id) {
      calls.push(`cancel:${session_id}`);
    },
  };
  return { port, calls };
}

test("transition table covers all ten statuses and keeps terminal states closed", () => {
  assert.deepEqual(Object.keys(TASK_TRANSITIONS).sort(), [...ALL].sort());
  for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
    assert.deepEqual(TASK_TRANSITIONS[terminal], []);
  }
  assert.equal(canTransition("queued", "succeeded"), false);
  assert.equal(canTransition("interrupted", "succeeded"), false);
  assert.equal(canTransition("waiting_user", "succeeded"), false);
  assert.equal(canTransition("running", "queued"), false);
  assert.equal(canTransition("waiting_user", "running"), true);
  assert.equal(canTransition("running", "interrupted"), true);
});

test("start creates a session and moves queued -> running with events", async () => {
  const { port, calls } = fakePort();
  const bridge = new TaskBridge({ dsh: port });
  const events: TaskStatus[] = [];
  const off = bridge.onStatusChange((status) => events.push(status));
  const started = await bridge.start(request);
  off();
  assert.equal(started.session_id, "s-1");
  assert.deepEqual(calls, ["create:s-1", "send:s-1:hello"]);
  assert.deepEqual(events.map((e) => e.status), ["queued", "running"]);
  assert.equal(bridge.get(started.task_id)?.status, "running");
});

test("illegal moves are rejected and leave state unchanged", async () => {
  const { port } = fakePort();
  const bridge = new TaskBridge({ dsh: port });
  const { task_id } = await bridge.start(request);
  bridge.transition(task_id, "failed");
  assert.throws(() => bridge.transition(task_id, "running"), TaskTransitionError);
  assert.throws(() => bridge.transition(task_id, "succeeded"), TaskTransitionError);
  assert.equal(bridge.get(task_id)?.status, "failed");
});

test("succeeded requires every requested artifact kind", async () => {
  const { port } = fakePort();
  const bridge = new TaskBridge({ dsh: port });
  const { task_id } = await bridge.start({ ...request, artifacts_needed: ["text", "video"] });
  const text = { artifact_id: "a-1", kind: "text" as const, path: "out.md", version: 1 };
  assert.throws(() => bridge.transition(task_id, "succeeded", [text]), /missing artifacts: video/);
  assert.equal(bridge.get(task_id)?.status, "running");
  const video = { artifact_id: "a-2", kind: "video" as const, path: "out.mp4", version: 1 };
  assert.equal(bridge.transition(task_id, "succeeded", [text, video]).status, "succeeded");
});

test("answer resumes waiting_user and is refused in other states", async () => {
  const { port, calls } = fakePort();
  const bridge = new TaskBridge({ dsh: port });
  const { task_id } = await bridge.start(request);
  await assert.rejects(bridge.answer(task_id, "yes"), TaskTransitionError);
  bridge.transition(task_id, "waiting_user");
  await bridge.answer(task_id, "yes");
  assert.equal(bridge.get(task_id)?.status, "running");
  assert.equal(calls.at(-1), "send:s-1:yes");
});

test("cancel from waiting_user cancels the DSH turn and is terminal", async () => {
  const { port, calls } = fakePort();
  const bridge = new TaskBridge({ dsh: port });
  const { task_id } = await bridge.start(request);
  bridge.transition(task_id, "waiting_user");
  await bridge.cancel(task_id);
  assert.equal(bridge.get(task_id)?.status, "cancelled");
  assert.equal(calls.at(-1), "cancel:s-1");
  await assert.rejects(bridge.cancel(task_id), TaskTransitionError);
  await assert.rejects(bridge.answer(task_id, "late"), TaskTransitionError);
});

test("restart marks running -> interrupted, never succeeded, and leaves others alone", async () => {
  const store = new InMemoryTaskStore();
  const { port } = fakePort();
  const first = new TaskBridge({ dsh: port, store });
  const running = await first.start(request);
  const waiting = await first.start(request);
  first.transition(waiting.task_id, "waiting_approval");

  // Simulate an app restart: a new bridge over the same persisted rows.
  const second = new TaskBridge({ dsh: fakePort().port, store });
  const recovered = second.recover();
  assert.deepEqual(recovered.map((t) => [t.task_id, t.status]), [[running.task_id, "interrupted"]]);
  assert.equal(second.get(running.task_id)?.status, "interrupted");
  assert.equal(second.get(waiting.task_id)?.status, "waiting_approval");
  assert.ok(store.list().every((row) => row.status !== "succeeded"));
});

test("resume reuses the original session_id and creates no new session", async () => {
  const store = new InMemoryTaskStore();
  const first = new TaskBridge({ dsh: fakePort().port, store });
  const { task_id, session_id } = await first.start(request);

  const { port, calls } = fakePort();
  const second = new TaskBridge({ dsh: port, store });
  second.recover();
  await second.resume(task_id, "continue");
  assert.deepEqual(calls, [`send:${session_id}:continue`]);
  assert.equal(store.get(task_id)?.session_id, session_id);
  assert.equal(second.get(task_id)?.status, "running");
  await assert.rejects(second.resume(task_id, "again"), TaskTransitionError);
});

test("send failure during start marks the task failed", async () => {
  const { port } = fakePort();
  const events: TaskStatus[] = [];
  const bridge = new TaskBridge({
    dsh: { ...port, send: async () => { throw new Error("dsh down"); } },
  });
  bridge.onStatusChange((status) => events.push(status));
  await assert.rejects(bridge.start(request), /dsh down/);
  assert.deepEqual(events.map((e) => e.status), ["queued", "failed"]);
});
