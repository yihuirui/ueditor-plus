# Security validation and distribution

Use the repository's locked Node.js toolchain when validating security changes:

```sh
nvm use
npm ci --ignore-scripts
npm test
npm run build
npm run check:examples
npm run test:example-sync
npm run test:dist
```

`npm test` runs the source-level security regressions. `npm run build` creates
`dist/` and `dist-min/`, then synchronizes the Vue 2, Vue 3, and React static
editor copies from the same `dist/` output. It writes the same deterministic
`ueditorplus-build-manifest.json` into each copy. The manifest records the
package version, full per-file SHA-256 lists for both `dist/` and `dist-min/`,
and a content-derived build ID; it contains no build timestamp.

`npm run check:examples` is read-only. It verifies all three copies against the
current build, including exact file sets, file hashes, and identical manifests.
It fails on missing/extra files, content drift, or any symlink and never removes
unknown files. `npm run sync:examples` performs the same safety preflight and
updates only those three allowlisted directories; run it after a successful
build when refreshing the checked-in static assets. If an unexpected file or
directory exists in a target, move it only after reviewing its ownership; the
sync command will stop rather than remove it.

`npm run test:example-sync` covers deterministic manifests, drift detection,
extra-file preservation, symlink refusal, and all-target preflight. The
source-level security suite and `npm run test:dist` still check source and
generated distribution behavior. The PR workflow runs these checks and
verifies that the built assets require no uncommitted changes; it does not
publish snapshot or npm releases. The master snapshot and tagged release
workflows run the same committed-asset check before their existing publish
steps.

For an additional real-browser check, set paths to a local Chrome executable
and an installed `playwright-core` package, then run:

```sh
CHROME_PATH=/path/to/chrome PLAYWRIGHT_CORE_PATH=/path/to/playwright-core npm run test:browser
```

The browser check uses a fresh headless context and a temporary server bound to
`127.0.0.1`; it blocks requests to every other origin and closes the browser
and server when the test ends. It checks real editor `setContent`, source-mode
round trips, and the Markdown import preview. Without both environment
variables, the test reports as skipped.

The Vue 2, Vue 3, and React production hosts have a separate optional browser
smoke test. First install their checked-in lockfiles and build each host, then
run it with the same isolated Chrome/Playwright paths:

```sh
npm ci --ignore-scripts --prefix _examples-integrate/vue2
npm ci --ignore-scripts --prefix _examples-integrate/vue3
npm ci --ignore-scripts --prefix _examples-integrate/reactx
npm --prefix _examples-integrate/vue2 run build
npm --prefix _examples-integrate/vue3 run build
npm --prefix _examples-integrate/reactx run build
CHROME_PATH=/path/to/chrome PLAYWRIGHT_CORE_PATH=/path/to/playwright-core npm run test:examples:browser
```

This test serves each production build on loopback, uses an ephemeral
headless-browser context, and aborts requests to any non-loopback origin. It
loads the actual Vue/React wrapper and synchronized static bundle, then checks
editor creation, `setContent`, source-mode switching, Markdown import preview,
and AI HTML preview. It does not call a configured backend or production
service. Without both browser paths, the three framework tests report as
skipped; a bundle-only fixture is not counted as a framework-host check.

## Integration assets

The checked-in static editor copies under the Vue 2, Vue 3, and React
integration examples are generated from `dist/` by `npm run build`:

- `_examples-integrate/vue2/public/static/UEditorPlus`
- `_examples-integrate/vue3/public/static/UEditorPlus`
- `_examples-integrate/reactx/public/static/UEditorPlus`

They are covered by `npm run check:examples`, which compares every copied file
with the just-built `dist/` tree and checks the `dist-min/` content fingerprint
recorded in each manifest. They are not included in `npm run test:dist`; that
test validates generated `dist/` and `dist-min/`. For changes to the integration
wrapper or static paths, build each example application and perform the
optional real-browser check as well.

Do not copy only selected dialog files: the HTML sanitizer is part of the
editor bundle, and dialogs depend on the public `UE.sanitizeHtml` interface
provided by that bundle.
