// Slash-command support for the editor textarea. Pure string logic lives here
// (unit-tested in tests/slashCommands.test.ts); the dropdown UI and upload
// wiring live in editor.ts.

export type SlashCommand = {
  id: string; // full command name, dash-separated ("add-image")
  label: string; // human label shown in the dropdown ("Add image")
};

export const SLASH_COMMANDS: SlashCommand[] = [{ id: "add-image", label: "Add image" }];

// A command matches while the query is a prefix of the full name OR of any of
// its dash-separated words — so "/a", "/add", "/add-im" and "/ima" all keep
// "add-image" suggested, while "/x" or a space dismisses it.
export function commandMatches(cmd: SlashCommand, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (cmd.id.startsWith(q)) return true;
  return cmd.id.split("-").some((w) => w.startsWith(q));
}

export type SlashContext = {
  start: number; // index of the "/" in the value
  query: string; // text between "/" and the caret
  matches: SlashCommand[];
};

// Find the active "/query" token ending at the caret. The "/" must sit at the
// start of a line or after whitespace (so URLs and mid-word slashes never
// trigger), and the query may not contain whitespace or another "/". Returns
// null when there is no token or nothing matches it — the caller hides the
// dropdown; the user's text is otherwise untouched, "/" can still be typed
// anywhere.
export function slashContext(value: string, caret: number): SlashContext | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const line = value.slice(lineStart, caret);
  const slash = line.lastIndexOf("/");
  if (slash === -1) return null;
  if (slash > 0 && !/\s/.test(line[slash - 1]!)) return null;
  const query = line.slice(slash + 1);
  if (/[\s/]/.test(query)) return null;
  const matches = SLASH_COMMANDS.filter((c) => commandMatches(c, query));
  if (matches.length === 0) return null;
  return { start: lineStart + slash, query, matches };
}

export type BlockInsertion = {
  value: string;
  blockStart: number; // range of the inserted block in the new value
  blockEnd: number;
};

// Replace the slash token (tokenStart..caret) with `block` on its own line:
// in place when the token is alone on its line, on the line below when the
// user typed the command after other text. Text after the caret on the same
// line stays where it is.
export function insertBlock(
  value: string,
  tokenStart: number,
  caret: number,
  block: string,
): BlockInsertion {
  const lineStart = value.lastIndexOf("\n", tokenStart - 1) + 1;
  const beforeToken = value.slice(lineStart, tokenStart);
  const withoutToken = value.slice(0, tokenStart) + value.slice(caret);

  if (beforeToken.trim() === "") {
    // Token alone on the line — the block takes its place.
    const out = withoutToken.slice(0, tokenStart) + block + withoutToken.slice(tokenStart);
    return { value: out, blockStart: tokenStart, blockEnd: tokenStart + block.length };
  }

  // Text before the token — put the block on the next line.
  let lineEnd = withoutToken.indexOf("\n", tokenStart);
  if (lineEnd === -1) lineEnd = withoutToken.length;
  const out = withoutToken.slice(0, lineEnd) + "\n" + block + withoutToken.slice(lineEnd);
  return { value: out, blockStart: lineEnd + 1, blockEnd: lineEnd + 1 + block.length };
}
