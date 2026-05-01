import { html, raw, layout } from "./layout.js";

export type EditorViewOpts = {
  mode: "new" | "edit";
  slug?: string;
  title: string;
  content: string;
};

export function editorPage(opts: EditorViewOpts): string {
  const isEdit = opts.mode === "edit" && opts.slug;
  const titlePrefix = isEdit ? `${opts.title || "untitled"} — edit` : "new page";
  const bodyData: Record<string, string> = {
    mode: isEdit ? "edit" : "new",
  };
  if (opts.slug) bodyData.slug = opts.slug;

  const body = html`
    <section class="editor-shell" id="editor">
      <div class="editor-actions" role="toolbar" aria-label="Editor actions">
        <span id="save-error" class="save-error" role="alert" aria-live="polite"></span>
        <button id="preview-toggle" class="btn" type="button" aria-pressed="false">preview: off</button>
        <button class="btn btn--primary" id="save-btn" type="button" disabled>${isEdit ? "save" : "publish"}</button>
      </div>

      <div class="editor-tabs" role="tablist" aria-label="Edit or preview">
        <button id="tab-edit" role="tab" aria-selected="true" aria-controls="pane-edit" type="button">edit</button>
        <button id="tab-preview" role="tab" aria-selected="false" aria-controls="pane-preview" type="button">preview</button>
      </div>

      <div class="split" data-preview-open="false">
        <div class="pane editor-pane" id="pane-edit" role="tabpanel" aria-labelledby="tab-edit">
          <input
            class="title"
            id="title-input"
            type="text"
            maxlength="200"
            autocomplete="off"
            spellcheck="true"
            placeholder="title"
            value="${opts.title}"
          />
          <textarea
            id="md-input"
            spellcheck="true"
            autocapitalize="off"
            autocorrect="off"
            placeholder="start typing **markdown**..."
          >${opts.content}</textarea>
        </div>
        <div class="pane preview-pane" id="pane-preview" role="tabpanel" aria-labelledby="tab-preview" hidden>
          <article class="prose" id="preview-output">
            <p class="placeholder"><em>preview appears here.</em></p>
          </article>
        </div>
      </div>
    </section>
  `;

  return layout({
    title: `${titlePrefix} — pencil.md`,
    description: "Write markdown with pencil.md.",
    bodyClass: "page-editor",
    bodyData,
    scripts: ["/client/editor.js"],
    body: raw(body),
    noIndex: true,
  });
}
