import type { StateDir } from "./state.js";
import type { Principal } from "./types.js";

export interface A2ADelegation {
  messageId: string;
  peer: string;
  conversationKey: string;
  deliveryKey: string;
  principal: Principal;
  replyRef?: Record<string, string | undefined>;
  taskId?: string;
  contextId?: string;
  /** When it was sent (ISO). */
  at?: string;
  /** The first words of the request, for context when the peer writes back on a new task. */
  summary?: string;
}

interface TaskRecord {
  taskId: string;
  contextId?: string;
  messageId?: string;
  state: string;
  conversationKey?: string;
}

export function a2aState(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/^task_state_/, "").replace(/-/g, "_");
}

export function a2aTerminal(value: unknown): boolean {
  return ["completed", "failed", "canceled", "cancelled", "rejected"].includes(a2aState(value));
}

/** Task delivery routes and terminal fences survive a process restart. */
export class A2AStore {
  constructor(private readonly state: StateDir) {}

  begin(delegation: A2ADelegation): void {
    const all = this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {});
    all[delegation.messageId] = delegation;
    this.state.writeJson("a2a-delegations.json", all);
  }

  confirm(messageId: string, result: { taskId?: string; contextId?: string }): void {
    const all = this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {});
    const record = all[messageId];
    if (!record) throw new Error("A2A delegation route is missing");
    if (result.taskId) record.taskId = result.taskId;
    if (result.contextId) record.contextId = result.contextId;
    this.state.writeJson("a2a-delegations.json", all);
  }

  delegation(taskId: string): A2ADelegation | undefined {
    return Object.values(this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {})).reverse().find((d) => d.taskId === taskId);
  }

  byMessage(messageId: string): A2ADelegation | undefined {
    return this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {})[messageId];
  }

  /** Requests the owner had this agent send to `peer`, newest first. */
  ownerAsksTo(peer: string): A2ADelegation[] {
    const want = peer.replace(/^@/, "").toLowerCase();
    return Object.values(this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {}))
      .filter((d) => d.principal.kind === "owner" && d.peer.replace(/^@/, "").toLowerCase() === want)
      .reverse();
  }

  hasPending(): boolean {
    return Object.values(this.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {})).some((d) => !d.taskId);
  }

  task(taskId: string): TaskRecord | undefined {
    return this.state.readJson<Record<string, TaskRecord>>("a2a-tasks.json", {})[taskId];
  }

  recordTask(task: TaskRecord): void {
    const all = this.state.readJson<Record<string, TaskRecord>>("a2a-tasks.json", {});
    const previous = all[task.taskId];
    // A delayed progress event must never reopen a settled task.
    if (previous && a2aTerminal(previous.state) && !a2aTerminal(task.state)) return;
    all[task.taskId] = { ...previous, ...task, state: a2aState(task.state) };
    this.state.writeJson("a2a-tasks.json", all);
  }

  active(taskId: string, messageId?: string): boolean {
    const task = this.task(taskId);
    return !task || (!a2aTerminal(task.state) && (!messageId || !task.messageId || task.messageId === messageId));
  }
}
