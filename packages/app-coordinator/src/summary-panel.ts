import type { PersonaSummaries } from "../../app-contracts/src/summary.ts";
import type { OverlayCommand, OverlaySummaryView } from "./overlay-protocol.ts";

/** Owns asynchronous summary inspection independently from confirmed-memory mutations. */
export class SummaryPanel {
  readonly view: OverlaySummaryView = { items: [], source: null, error: null };
  private readonly port: PersonaSummaries;
  private readonly changed: () => void;
  private readonly unsubscribe: () => void;
  private closed = false;
  private readVersion = 0;
  private commandVersion = 0;
  private commandError = false;

  constructor(port: PersonaSummaries, changed: () => void) {
    this.port = port; this.changed = changed;
    this.unsubscribe = port.subscribe(() => { void this.refresh(); });
    void this.refresh();
  }
  dispose(): void { this.closed = true; this.unsubscribe(); }

  async refresh(): Promise<void> {
    if (this.closed) return;
    const version = ++this.readVersion;
    try {
      const items = await this.port.list();
      if (this.closed || version !== this.readVersion) return;
      this.view.items = items;
      if (this.view.source && !items.some((s) => s.id === this.view.source!.summaryId)) this.view.source = null;
      if (!this.commandError) this.view.error = null;
    } catch {
      if (this.closed || version !== this.readVersion) return;
      if (!this.commandError) this.view.error = "摘要加载失败，请重新打开记忆面板重试";
    }
    this.changed();
  }

  async handle(command: Extract<OverlayCommand, { type: "summary-sources" | "summary-remove" }>): Promise<void> {
    if (this.closed) return;
    const version = ++this.commandVersion;
    try {
      if (command.type === "summary-remove") {
        await this.port.remove(command.id);
        if (this.closed || version !== this.commandVersion) return;
        if (this.view.source?.summaryId === command.id) this.view.source = null;
      } else {
        const messages = await this.port.sources(command.id);
        if (this.closed || version !== this.commandVersion || !this.view.items.some((s) => s.id === command.id)) return;
        this.view.source = { summaryId: command.id, messages: messages.map((m) => ({ id: m.id, role: m.role, text: m.text.slice(0, 4000), createdAt: m.createdAt, truncated: m.text.length > 4000 })) };
      }
      this.view.error = null; this.commandError = false;
      this.changed();
      if (command.type === "summary-remove") await this.refresh();
    } catch {
      if (this.closed || version !== this.commandVersion) return;
      this.commandError = true;
      this.view.error = command.type === "summary-remove" ? "摘要删除失败，请稍后重试" : "原始消息读取失败，请稍后重试";
      this.changed();
    }
  }
}
