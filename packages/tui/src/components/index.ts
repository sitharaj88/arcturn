/**
 * Re-exports for every built-in component.
 *
 * @packageDocumentation
 */

export {
  BORDERS,
  type BorderChars,
  type BorderStyle,
  Box,
  type BoxOptions,
  type BoxPadding,
} from "./box.js";
export { Divider, type DividerOptions } from "./divider.js";
export {
  type AutocompleteContext,
  type AutocompleteProvider,
  type AutocompleteSuggestion,
  Editor,
  type EditorOptions,
  type EditorState,
  wordBoundaryBackward,
  wordBoundaryForward,
} from "./editor.js";
export {
  highlightCode,
  Markdown,
  type MarkdownOptions,
  MarkdownStream,
  renderMarkdown,
} from "./markdown.js";
export {
  type SelectItem,
  SelectList,
  type SelectListOptions,
} from "./select-list.js";
export {
  SPINNER_FRAMES,
  Spinner,
  type SpinnerName,
  type SpinnerOptions,
} from "./spinner.js";
export { Stack, type StackOptions } from "./stack.js";
export { StatusBar, type StatusBarOptions, type StatusSegment } from "./status-bar.js";
export { resolveStyle, Text, type TextOptions } from "./text.js";
export { Viewport, type ViewportOptions } from "./viewport.js";
