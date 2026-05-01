// Ambient module declarations for markdown-it plugins that ship without types.

declare module "markdown-it-footnote" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions<{
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
    lineNumber?: boolean;
  }>;
  export default plugin;
}

declare module "markdown-it-mark" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}

declare module "markdown-it-toc-done-right" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions<{
    listType?: "ul" | "ol";
    containerClass?: string;
    placeholder?: string;
    level?: number | number[];
  }>;
  export default plugin;
}
