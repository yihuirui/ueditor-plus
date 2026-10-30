'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH;
const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH;
const payload = (label) =>
    `<p>${label} <strong>safe formatting</strong></p>` +
    '<img src="http://blocked.invalid/payload.png" onerror="window.top.__syncPayloadExecuted++">' +
    '<script>window.top.__syncPayloadExecuted++</script>';

const examples = [
    { name: 'Vue 2', directory: '_examples-integrate/vue2', output: 'dist' },
    { name: 'Vue 3', directory: '_examples-integrate/vue3', output: 'dist' },
    { name: 'React', directory: '_examples-integrate/reactx', output: 'build' }
];

function contentType(filePath) {
    return ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.ico': 'image/x-icon',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2'
    })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticServer(root) {
    const canonicalRoot = fs.realpathSync(root);
    return http.createServer((request, response) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        } catch (error) {
            response.writeHead(400);
            response.end();
            return;
        }
        const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const candidate = path.resolve(canonicalRoot, relativePath);
        if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + path.sep)) {
            response.writeHead(403);
            response.end();
            return;
        }
        let actual;
        try {
            actual = fs.realpathSync(candidate);
            if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + path.sep)) {
                response.writeHead(403);
                response.end();
                return;
            }
            if (!fs.statSync(actual).isFile()) {
                throw new Error('not a file');
            }
        } catch (error) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': contentType(actual), 'cache-control': 'no-store' });
        fs.createReadStream(actual).pipe(response);
    });
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function runBrowserSmoke(example, t) {
    const outputRoot = path.join(repositoryRoot, example.directory, example.output);
    assert.ok(fs.existsSync(path.join(outputRoot, 'index.html')), `${example.name} production build exists`);

    const { chromium } = require(path.resolve(playwrightCorePath));
    assert.ok(chromium, 'playwright-core exports chromium');
    const server = createStaticServer(outputRoot);
    const baseUrl = await listen(server);
    let browser;
    let context;

    t.after(async () => {
        if (context) await context.close();
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    });

    browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--disable-background-networking', '--disable-extensions']
    });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', (route) => {
        try {
            if (new URL(route.request().url()).origin === baseUrl) {
                return route.continue();
            }
        } catch (error) {
        }
        return route.abort();
    });
    await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
        const instances = window.UE && window.UE.instants;
        return instances && Object.keys(instances).some((key) => instances[key] && instances[key].body);
    }, null, { timeout: 30000 });

    const initial = await page.evaluate(() => new Promise((resolve, reject) => {
        try {
            const instance = Object.values(window.UE.instants).find((value) => value && value.body);
            instance.ready(() => {
                window.__syncPayloadExecuted = 0;
                window.__syncEditor = instance;
                resolve({
                    editorId: instance.key || instance.container && instance.container.id || 'registered',
                    importDialog: !!(instance.ui && instance.ui._dialogs && instance.ui._dialogs.contentimportDialog),
                    aiDialog: !!(instance.ui && instance.ui._dialogs && instance.ui._dialogs.aiDialog)
                });
            });
        } catch (error) {
            reject(error);
        }
    }));
    assert.equal(initial.importDialog, true, `${example.name} registers the import dialog`);
    assert.equal(initial.aiDialog, true, `${example.name} registers the AI dialog`);

    const editorState = await page.evaluate((unsafeHtml) => {
        const editor = window.__syncEditor;
        editor.setContent(unsafeHtml);
        const setContent = editor.body.innerHTML;
        editor.options.sourceEditor = 'textarea';
        editor.execCommand('source');
        const source = editor.iframe.parentNode.querySelector('textarea');
        if (!source) throw new Error('source textarea did not open');
        source.value = unsafeHtml;
        editor.execCommand('source');
        return new Promise((resolve) => window.setTimeout(() => resolve({
            setContent,
            source: editor.body.innerHTML,
            executed: window.__syncPayloadExecuted
        }), 100));
    }, payload(`${example.name} content`));
    assert.match(editorState.setContent, /<strong>safe formatting<\/strong>/, `${example.name} retains normal formatting`);
    assert.doesNotMatch(editorState.setContent, /<script|onerror=/i, `${example.name} sanitizes setContent`);
    assert.match(editorState.source, /<strong>safe formatting<\/strong>/, `${example.name} retains formatting after source switch`);
    assert.doesNotMatch(editorState.source, /<script|onerror=/i, `${example.name} sanitizes source-mode input`);
    assert.equal(editorState.executed, 0, `${example.name} does not execute the payload`);

    await page.evaluate(() => {
        const dialog = window.__syncEditor.ui._dialogs.contentimportDialog;
        dialog.render();
        dialog.open();
    });
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('iframe')).some((frame) => {
            return /dialogs\/contentimport\/contentimport\.html/.test(frame.src) &&
                frame.contentDocument && frame.contentWindow &&
                typeof frame.contentWindow.processMarkdown === 'function' &&
                !!frame.contentWindow.contentImport;
        }),
        null,
        { timeout: 15000 }
    );
    const importFrame = page.frames().find((frame) => /dialogs\/contentimport\/contentimport\.html/.test(frame.url()));
    assert.ok(importFrame, `${example.name} loads its built Markdown import dialog`);
    const importResult = await importFrame.evaluate((markdown) => {
        if (typeof window.processMarkdown !== 'function' || !window.contentImport) {
            throw new Error('Markdown import processing is unavailable');
        }
        window.processMarkdown(markdown);
        return {
            preview: document.querySelector('.file-result').innerHTML,
            stored: window.contentImport.data.result
        };
    }, payload(`${example.name} markdown`));
    assert.match(importResult.preview, /<strong>safe formatting<\/strong>/, `${example.name} Markdown preview preserves formatting`);
    assert.doesNotMatch(importResult.preview, /<script|onerror=/i, `${example.name} Markdown preview is sanitized`);
    assert.doesNotMatch(importResult.stored, /<script|onerror=/i, `${example.name} stored Markdown is sanitized`);

    await page.evaluate(() => {
        const dialog = window.__syncEditor.ui._dialogs.aiDialog;
        dialog.render();
        dialog.open();
    });
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('iframe')).some((frame) => {
            const appElement = frame.contentDocument && frame.contentDocument.getElementById('app');
            return /dialogs\/ai\/ai\.html/.test(frame.src) &&
                frame.contentWindow && frame.contentWindow.Vue &&
                appElement && appElement.__vue__;
        }),
        null,
        { timeout: 15000 }
    );
    const aiFrame = page.frames().find((frame) => /dialogs\/ai\/ai\.html/.test(frame.url()));
    assert.ok(aiFrame, `${example.name} loads its built AI dialog`);
    const aiPreview = await aiFrame.evaluate((text) => new Promise((resolve, reject) => {
        try {
            const app = document.getElementById('app').__vue__;
            if (!app) throw new Error('AI preview Vue instance is unavailable');
            app.resultText = text;
            window.Vue.nextTick(() => resolve(document.querySelector('.ub-html').innerHTML));
        } catch (error) {
            reject(error);
        }
    }), payload(`${example.name} AI result`));
    assert.match(aiPreview, /<strong>safe formatting<\/strong>/, `${example.name} AI preview preserves formatting`);
    assert.doesNotMatch(aiPreview, /<script|onerror=/i, `${example.name} AI preview is sanitized`);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__syncPayloadExecuted), 0, `${example.name} import and AI payloads did not execute`);
}

for (const example of examples) {
    test(`${example.name} production host loads synchronized editor and passes security smoke`, {
        skip: chromePath && playwrightCorePath ? false : 'Set CHROME_PATH and PLAYWRIGHT_CORE_PATH to run the isolated headless host check'
    }, async (t) => {
        assert.ok(fs.existsSync(chromePath), `Chrome executable exists: ${chromePath}`);
        await runBrowserSmoke(example, t);
    });
}

