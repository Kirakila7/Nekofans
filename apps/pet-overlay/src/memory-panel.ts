import type {
  OverlayCommand,
  OverlayMemoryItem,
  OverlayMemoryView,
} from "../../../packages/app-coordinator/src/overlay-protocol.ts";

interface MemoryPanelElements {
  panel: HTMLElement;
  pending: HTMLElement;
  confirmed: HTMLElement;
  error: HTMLElement;
  close: HTMLButtonElement;
  send: (command: OverlayCommand) => void;
}

interface MemoryEditor {
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  submitted: string | null;
}

interface MemoryRow {
  element: HTMLLIElement;
  text: HTMLElement;
  meta: HTMLElement;
  actions: HTMLElement;
  confirm: HTMLButtonElement;
  edit: HTMLButtonElement;
  item: OverlayMemoryItem;
  editor: MemoryEditor | null;
}

const KIND_TEXT: Readonly<Record<OverlayMemoryItem["kind"], string>> = {
  fact: "事实",
  preference: "偏好",
  episode: "经历",
  summary: "摘要",
};

/** A keyed view: streamed chat snapshots never replace an active memory editor. */
export function mountMemoryPanel(elements: MemoryPanelElements): {
  render(memory: OverlayMemoryView | null): void;
  close(): void;
} {
  const rows = new Map<string, MemoryRow>();
  let signature: string | undefined;

  function button(text: string, className: string, action: () => void): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = text;
    element.addEventListener("click", action);
    return element;
  }

  function finishEditing(row: MemoryRow, restoreFocus = false): void {
    row.editor?.form.remove();
    row.editor = null;
    row.text.textContent = row.item.text;
    row.text.hidden = false;
    row.actions.hidden = false;
    if (restoreFocus) row.edit.focus();
  }

  function startEditing(row: MemoryRow): void {
    if (row.editor) return;
    const form = document.createElement("form");
    const input = document.createElement("textarea");
    input.className = "memory-editor";
    input.maxLength = 8000;
    input.required = true;
    input.rows = 4;
    input.value = row.item.text;
    input.setAttribute("aria-label", "修改记忆内容");
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-btn";
    save.textContent = "保存";
    const cancel = button("取消", "quiet-btn", () => finishEditing(row, true));
    const editor: MemoryEditor = { form, input, submitted: null };
    row.editor = editor;
    const updateValidity = (): void => {
      save.disabled = input.value.trim().length === 0 || input.value.length > 8000;
    };
    input.addEventListener("input", updateValidity);
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishEditing(row, true);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || input.value.length > 8000) return;
      // Keep the draft until a snapshot acknowledges it; failures must not erase it.
      editor.submitted = text;
      elements.send({ type: "memory-update", id: row.item.id, text });
      if (row.item.text === text && row.editor === editor) finishEditing(row, true);
    });
    updateValidity();
    actions.append(save, cancel);
    form.append(input, actions);
    row.text.hidden = true;
    row.actions.hidden = true;
    row.element.append(form);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function createRow(item: OverlayMemoryItem): MemoryRow {
    const element = document.createElement("li");
    element.className = "memory-item";
    element.dataset.memoryId = item.id;
    const text = document.createElement("p");
    text.className = "memory-text";
    const meta = document.createElement("p");
    meta.className = "memory-meta";
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const confirm = button("确认", "primary-btn", () => {
      elements.send({ type: "memory-confirm", id: row.item.id });
    });
    const edit = button("修改", "quiet-btn", () => startEditing(row));
    const remove = button("删除", "danger-btn", () => {
      elements.send({ type: "memory-remove", id: row.item.id });
    });
    const row: MemoryRow = { element, text, meta, actions, confirm, edit, item, editor: null };
    actions.append(confirm, edit, remove);
    element.append(text, meta, actions);
    return row;
  }

  function renderList(container: HTMLElement, items: OverlayMemoryItem[], pending: boolean): void {
    container.querySelector(".memory-empty")?.remove();
    let position = container.firstChild;
    for (const item of items) {
      let row = rows.get(item.id);
      if (!row) {
        row = createRow(item);
        rows.set(item.id, row);
      }
      row.item = item;
      row.confirm.hidden = !pending;
      const date = new Date(item.updated_at);
      const stamp = Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN");
      row.meta.textContent = `${pending ? "待确认" : "已确认"} · ${KIND_TEXT[item.kind]}${stamp ? ` · ${stamp}` : ""}`;
      const editor = row.editor;
      if (editor?.submitted === item.text) {
        if (editor.input.value.trim() === editor.submitted) {
          finishEditing(row, document.activeElement === editor.input);
        } else {
          // A newer local draft wins over the acknowledgement of the previous save.
          editor.submitted = null;
        }
      }
      if (!row.editor) row.text.textContent = item.text;
      if (row.element !== position) container.insertBefore(row.element, position);
      position = row.element.nextSibling;
    }
    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memory-empty";
      empty.textContent = pending ? "没有待确认的记忆" : "还没有已确认的记忆";
      container.append(empty);
    }
  }

  function close(): void {
    elements.send({ type: "hide-memories" });
  }
  elements.close.addEventListener("click", close);

  return {
    close,
    render(memory): void {
      const nextSignature = JSON.stringify(memory);
      if (nextSignature === signature) return;
      signature = nextSignature;
      elements.panel.hidden = !memory?.panel_open;
      elements.error.textContent = memory?.error ?? "";
      elements.error.hidden = !memory?.error;
      if (!memory) return;
      const active = document.activeElement;
      const ids = new Set([...memory.pending, ...memory.confirmed].map((item) => item.id));
      for (const [id, row] of rows) {
        if (!ids.has(id)) {
          row.element.remove();
          rows.delete(id);
        }
      }
      renderList(elements.pending, memory.pending, true);
      renderList(elements.confirmed, memory.confirmed, false);
      // Reordering an existing node may blur it in some browsers. Keep the caret.
      if (active instanceof HTMLTextAreaElement && active.isConnected && document.activeElement !== active) {
        active.focus({ preventScroll: true });
      }
    },
  };
}
