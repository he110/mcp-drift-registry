/**
 * The two escaping helpers every renderer needs.
 *
 * They live apart from `render.js` so that a second page module can use them
 * without the two files importing each other.
 */

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Summaries are written with `backticks`; render them as code, escaped. */
export function inlineCode(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}
