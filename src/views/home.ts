import { editorPage } from "./editor.js";

export function homePage(): string {
  return editorPage({
    mode: "new",
    title: "",
    content: "",
  });
}
