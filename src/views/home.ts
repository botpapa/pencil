import { editorPage } from "./editor.js";

export function homePage(showPagesLink = false, host?: string): string {
  return editorPage({
    mode: "new",
    title: "",
    content: "",
    showPagesLink,
    host,
  });
}
