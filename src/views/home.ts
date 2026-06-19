import { editorPage } from "./editor.js";

export function homePage(showPagesLink = false): string {
  return editorPage({
    mode: "new",
    title: "",
    content: "",
    showPagesLink,
  });
}
