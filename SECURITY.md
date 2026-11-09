# Security Policy

This repository is a downstream fork of [modstart-lib/ueditor-plus](https://github.com/modstart-lib/ueditor-plus) (Apache-2.0). It is **not** an official release channel.

## Where to report

Issues are disabled on this fork and private vulnerability reporting is not enabled. Please do **not** post vulnerability details in a public issue, discussion or pull request here.

- For problems inherited from upstream, or affecting UEditor Plus in general, use the upstream project's own reporting channel and maintainer contact information.
- For the fork-specific changes in this repository, contact the repository owner directly until a private reporting channel is enabled here.
- Security-relevant behaviour is documented in `docs/html-security.md`, `docs/ai-proxy.md`, `docs/security-changes.md` and `docs/security-validation.md`. Several restrictions are intentional breaking changes: script and event attributes are stripped, dangerous links are rejected, retained iframes use a restricted sandbox, and the AI feature calls a same-origin backend proxy rather than a vendor endpoint with a browser-side API key. Please read these documents before treating such behaviour as a defect.

## Scope notes

Client-side sanitization and file-type checks are defense in depth. They do **not** replace server-side authentication, upload validation, output escaping or a Content Security Policy. The bundled `_demo_server` is a demonstration endpoint and must not be deployed as-is.

Security regressions are covered by `npm test`, `npm run test:dist` and the browser suites listed in `package.json`; these run in the `Snapshot Build` and `Pull Request Verification` workflows.
