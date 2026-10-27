import type { OverlayCommand, OverlaySummaryView } from "../../../packages/app-coordinator/src/overlay-protocol.ts";

export function mountSummaryPanel(elements: { section: HTMLElement; list: HTMLElement; error: HTMLElement; send: (command: OverlayCommand) => void }) {
  let signature: string | undefined;
  const text = (tag: string, value: string, className: string) => {
    const element = document.createElement(tag); element.className = className; element.textContent = value; return element;
  };
  return {
    render(view: OverlaySummaryView | undefined): void {
      elements.section.hidden = !view;
      const next = JSON.stringify(view);
      if (!view || signature === next) return;
      signature = next;
      elements.error.hidden = !view.error; elements.error.textContent = view.error ?? "";
      const scroll = elements.section.closest(".memory-scroll");
      const scrollTop = scroll?.scrollTop ?? 0;
      const rows = view.items.map((item) => {
        const li = document.createElement("li"); li.className = "memory-item summary-item"; li.dataset.summaryId = item.id;
        li.append(text("p", `${item.sourceMessageIds.length} 条来源 · ${new Date(item.updatedAt).toLocaleString("zh-CN")} · 自动摘录`, "memory-meta"));
        li.append(text("p", item.text, "memory-text"));
        const actions = document.createElement("div"); actions.className = "memory-actions";
        const sources = document.createElement("button"); sources.type = "button"; sources.className = "quiet-btn"; sources.textContent = "查看来源原文";
        sources.onclick = () => elements.send({ type: "summary-sources", id: item.id });
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-btn"; remove.textContent = "删除摘要";
        remove.onclick = () => elements.send({ type: "summary-remove", id: item.id });
        actions.append(sources, remove); li.append(actions);
        if (view.source?.summaryId === item.id) {
          const details = document.createElement("details"); details.className = "summary-sources"; details.open = true;
          details.append(text("summary", "来源消息原文", "summary-source-title"));
          for (const message of view.source.messages) {
            const metadata = text("p", `${message.role === "user" ? "用户" : "角色回复"} · ${new Date(message.createdAt).toLocaleString("zh-CN")}`, "memory-meta");
            metadata.title = `来源消息：${message.id}`;
            details.append(metadata);
            details.append(text("p", message.text + (message.truncated ? "\n（此处仅展示前 4000 字符；完整原文仍保存在聊天记录中）" : ""), "memory-text"));
          }
          li.append(details);
        }
        return li;
      });
      if (!rows.length) {
        const empty = document.createElement("li"); empty.className = "memory-empty"; empty.textContent = "聊天变长后，会在这里生成带来源的摘要。"; rows.push(empty);
      }
      elements.list.replaceChildren(...rows);
      if (scroll) scroll.scrollTop = scrollTop;
    },
  };
}
