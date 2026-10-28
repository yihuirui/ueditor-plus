# HTML input security

UEditorPlus now exposes a synchronous `UE.sanitizeHtml(html)` boundary backed
by a pinned DOMPurify instance. The development loader in
`_examples/editor_api.js` loads `_src/core/sanitizer.js` followed by
`_src/vendor/DOMPurify/dist/purify.isolated.js`, before editor code can accept
content. The isolated wrapper embeds the unchanged minified upstream payload
from [DOMPurify 3.4.17](https://github.com/cure53/DOMPurify/tree/3.4.17), with
its local CommonJS objects so it does not replace a host `DOMPurify` global or
interact with an AMD loader. The upstream full and minified files are retained
under `dist/` for review. Their SHA-256 hashes are:

* `purify.js`: `a7b6dc750251c79c95592d6abf8908bcecb51319b0b5c4194b82222566ed29b9`
* `purify.min.js`: `cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31`

The upstream dual-license text is in
[`_src/vendor/DOMPurify/LICENSE`](../_src/vendor/DOMPurify/LICENSE). If the
runtime purifier is missing, throws, or reports an unsupported DOM,
`UE.sanitizeHtml` encodes the input as text. It does not pass the original HTML
through or provide a setting that disables this behavior.

The editor sanitizes content at `setContent`, source-mode reads and writes,
paste and `inserthtml`, and again after output rules and output callbacks. This
second pass also covers markup created by editor plugins and custom callbacks.
Import previews sanitize Markdown and DOCX-converted HTML before assigning it
directly to the preview element; confirmation sanitizes the stored content
again before insertion. The preview deliberately avoids the project's legacy
jQuery `.html()` path, which may rewrite already-sanitized input. Link commands
and iframe dialogs validate URLs at their own UI boundaries. Existing iframe
updates sanitize the replacement before touching the editor DOM.

Scripts, event-handler attributes, object/embed/applet elements, executable
URL schemes, and UEditor round-trip metadata (`cdata_tag`, `cdata_data`,
`_src`, `_href`, `_ue_custom_node_`) are removed. Ordinary text, paragraphs,
tables, lists, images, links, and inline formatting remain supported. Iframes
are retained only for HTTP(S) URLs; they receive an empty `sandbox` and
`referrerpolicy="no-referrer"`, and permissions such as `allow`,
`allowfullscreen`, and `srcdoc` are removed. This intentionally disables iframe
scripts, same-origin access, and form submission. Content that depends on
embedded script/style blocks or privileged iframe behavior must be handled by
application code outside editor HTML. Inline style declarations are parsed and
normalized through the browser CSS parser; URL, variable-expansion, and legacy
script-bearing declarations are dropped, while ordinary formatting such as
color remains available.

The sanitizer uses DOMPurify's supported DOM implementation. In environments
where its runtime bundle cannot parse or DOMPurify reports `isSupported` false,
HTML is shown as escaped text to keep the boundary closed; verify supported
browsers against the project's deployment matrix before rollout. These
changes do not upgrade the bundled jQuery version.
