'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const distRoot = path.resolve(__dirname, '..', 'dist');
const chromePath = process.env.CHROME_PATH;
const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH;

function contentType(filePath) {
    return ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
    })[path.extname(filePath)] || 'application/octet-stream';
}

function createStaticServer() {
    return http.createServer(function (request, response) {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/__security-smoke') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(
                '<!doctype html><html lang="zh-cn"><head><meta charset="utf-8">' +
                '<script src="/ueditor.config.js"></script>' +
                '<script src="/ueditor.all.js"></script>' +
                '<script src="/lang/zh-cn/zh-cn.js"></script>' +
                '</head><body><div id="editor"></div></body></html>'
            );
            return;
        }

        const filePath = path.resolve(distRoot, `.${decodeURIComponent(pathname)}`);
        if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
            response.writeHead(403);
            response.end();
            return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.writeHead(404);
            response.end();
            return;
        }

        response.writeHead(200, { 'content-type': contentType(filePath) });
        fs.createReadStream(filePath).pipe(response);
    });
}

test('real Chrome keeps setContent, source mode, and Markdown preview safe', {
    skip: chromePath && playwrightCorePath ? false : 'Set CHROME_PATH and PLAYWRIGHT_CORE_PATH to run the isolated headless browser check'
}, async function (t) {
    assert.ok(fs.existsSync(chromePath), `Chrome executable exists: ${chromePath}`);
    const { chromium } = require(path.resolve(playwrightCorePath));
    assert.ok(chromium, 'playwright-core exports chromium');

    const server = createStaticServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let browser;
    let context;

    t.after(async function () {
        if (context) await context.close();
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    });

    browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--disable-background-networking', '--disable-extensions']
    });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', function (route) {
        let requestOrigin = '';
        try {
            requestOrigin = new URL(route.request().url()).origin;
        } catch (error) {
        }
        return requestOrigin === baseUrl ? route.continue() : route.abort();
    });
    await page.goto(`${baseUrl}/__security-smoke`, { waitUntil: 'load' });

    const editorState = await page.evaluate(function () {
        return new Promise(function (resolve, reject) {
            try {
                window.__securityPayloadExecuted = 0;
                const editor = window.UE.getEditor('editor', {
                    UEDITOR_HOME_URL: `${window.location.origin}/`,
                    lang: 'zh-cn',
                    loadConfigFromServer: false,
                    autoHeightEnabled: false,
                    enableAutoSave: false,
                    initialFrameHeight: 280,
                    initialFrameWidth: 620,
                    sourceEditor: 'textarea',
                    toolbars: [['source', 'contentimport']]
                });
                window.__securityEditor = editor;
                const timeout = window.setTimeout(() => reject(new Error('editor ready timed out')), 15000);
                editor.ready(function () {
                    window.clearTimeout(timeout);
                    try {
                        const badImage = '<img src="http://outside.invalid/set-content.png" onerror="window.top.__securityPayloadExecuted++">';
                        editor.setContent('<p>setContent <strong>rich text</strong></p>' + badImage + '<script>window.top.__securityPayloadExecuted++</script>');
                        const setContentHtml = editor.body.innerHTML;
                        editor.execCommand('source');
                        const source = editor.iframe.parentNode.querySelector('textarea');
                        if (!source) throw new Error('source editor textarea was not created');
                        source.value = '<p>source <strong>rich text</strong></p>' + badImage + '<script>window.top.__securityPayloadExecuted++</script>';
                        editor.execCommand('source');
                        window.setTimeout(function () {
                            resolve({
                                setContent: setContentHtml,
                                source: editor.body.innerHTML,
                                executed: window.__securityPayloadExecuted,
                                dialogAvailable: !!(editor.ui && editor.ui._dialogs && editor.ui._dialogs.contentimportDialog)
                            });
                        }, 100);
                    } catch (error) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    });

    assert.equal(editorState.executed, 0, 'image error payloads did not execute');
    assert.match(editorState.setContent, /<strong>rich text<\/strong>/, 'setContent retains safe rich text');
    assert.doesNotMatch(editorState.setContent, /<script|onerror=/i, 'setContent removes active content');
    assert.match(editorState.source, /<strong>rich text<\/strong>/, 'source round trip retains safe rich text');
    assert.doesNotMatch(editorState.source, /<script|onerror=/i, 'source round trip removes active content');
    assert.equal(editorState.dialogAvailable, true, 'content import dialog is registered by the real editor');

    await page.evaluate(function () {
        const editor = window.__securityEditor;
        const dialog = editor.ui._dialogs.contentimportDialog;
        dialog.render();
        dialog.open();
    });
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('iframe')).some(frame => /dialogs\/contentimport\/contentimport\.html/.test(frame.src)),
        null,
        { timeout: 15000 }
    );
    const importFrame = page.frames().find(frame => /dialogs\/contentimport\/contentimport\.html/.test(frame.url()));
    assert.ok(importFrame, 'real Markdown import dialog frame loaded');
    await importFrame.waitForFunction(
        () => typeof window.processMarkdown === 'function' && !!window.contentImport,
        null,
        { timeout: 15000 }
    );

    const preview = await importFrame.evaluate(function () {
        const markdown = [
            '<p>Markdown <strong>rich text</strong></p>',
            '<img src="http://outside.invalid/markdown.png" onerror="window.top.__securityPayloadExecuted++">',
            '<script>window.top.__securityPayloadExecuted++</script>'
        ].join('');
        window.processMarkdown(markdown);
        return {
            html: document.querySelector('.file-result').innerHTML,
            result: window.contentImport.data.result
        };
    });
    assert.match(preview.html, /<strong>rich text<\/strong>/, 'Markdown preview retains safe rich text');
    assert.doesNotMatch(preview.html, /<script|onerror=/i, 'Markdown preview strips active content');
    assert.doesNotMatch(preview.result, /<script|onerror=/i, 'stored Markdown result is sanitized too');

    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__securityPayloadExecuted), 0, 'Markdown image error payload did not execute');
});
