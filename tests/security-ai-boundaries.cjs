const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder, TextEncoder } = require('node:util');
const { JSDOM } = require('jsdom');

const aiSource = fs.readFileSync(path.join(__dirname, '..', 'dialogs', 'ai', 'ai.js'), 'utf8');
const purifierSource = fs.readFileSync(path.join(__dirname, '..', '_src', 'vendor', 'DOMPurify', 'dist', 'purify.isolated.js'), 'utf8');
const sanitizerSource = fs.readFileSync(path.join(__dirname, '..', '_src', 'core', 'sanitizer.js'), 'utf8');

function sseResponse(chunks, lifecycle) {
    lifecycle = lifecycle || {};
    const encoder = new TextEncoder();
    const values = chunks.map(function (chunk) {
        return typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    });
    return {
        ok: true,
        status: 200,
        body: {
            getReader: function () {
                var index = 0;
                return {
                    read: function () {
                        lifecycle.readCalls = (lifecycle.readCalls || 0) + 1;
                        if (index >= values.length) {
                            return Promise.resolve({ done: true });
                        }
                        return Promise.resolve({ done: false, value: values[index++] });
                    },
                    cancel: function () {
                        lifecycle.cancelCalls = (lifecycle.cancelCalls || 0) + 1;
                        return lifecycle.cancelPromise || Promise.resolve();
                    },
                    releaseLock: function () {
                        lifecycle.releaseCalls = (lifecycle.releaseCalls || 0) + 1;
                    }
                };
            }
        }
    };
}

function setup(options) {
    options = options || {};
    const dom = new JSDOM('<!doctype html><div id="app"></div>', {
        url: 'https://editor.example.test/edit',
        runScripts: 'outside-only'
    });
    const window = dom.window;
    const rangeState = { inserted: [], deleted: 0 };
    const range = {
        cloneContents: function () {
            return { textContent: options.selectedText || '' };
        },
        insertNode: function (node) {
            rangeState.inserted.push(node);
        },
        deleteContents: function () {
            rangeState.deleted++;
        }
    };
    const state = {
        fetchCalls: [],
        commands: [],
        contents: [],
        events: [],
        errors: [],
        closeCalls: [],
        rangeState: rangeState
    };
    const aiConfig = options.ai || { driver: 'Proxy', driverConfig: {} };
    const aiFunctions = options.aiFunctions || [];
    const editor = {
        getOpt: function (key) {
            if (key === 'ai') return aiConfig;
            if (key === 'aiFunctions') return aiFunctions;
            return undefined;
        },
        selection: { getRange: function () { return range; } },
        getContent: function () { return options.content || '<p>current document</p>'; },
        execCommand: function (command, value) { state.commands.push([command, value]); },
        setContent: function (value) { state.contents.push(value); },
        fireEvent: function (name) { state.events.push(name); },
        tipError: function (message) { state.errors.push(message); }
    };
    window.TextDecoder = TextDecoder;
    window.TextEncoder = TextEncoder;
    window.editor = editor;
    window.dialog = { close: function (value) { state.closeCalls.push(value); } };
    window.utils = { domReady: function (callback) { callback(); } };
    window.showdown = {
        Converter: function () {
            this.makeHtml = function (text) {
                return '<p>' + String(text).replace(/\r?\n/g, '</p><p>') + '</p>';
            };
        }
    };
    window.UE = {};
    if (options.sanitizer !== false) {
        if (options.sanitizer) {
            window.UE.sanitizeHtml = options.sanitizer;
        } else {
            window.eval(purifierSource);
            window.eval(sanitizerSource);
        }
    }
    window.fetch = function (url, requestOptions) {
        state.fetchCalls.push({ url: url, options: requestOptions });
        if (options.fetch) {
            return options.fetch(url, requestOptions);
        }
        return Promise.resolve(sseResponse([
            'data: {"type":"data","data":"generated"}\n\n',
            'data: {"type":"end"}\n\n'
        ]));
    };
    window.Vue = function (vueOptions) {
        const instance = Object.assign({}, vueOptions.data);
        Object.keys(vueOptions.methods).forEach(function (name) {
            instance[name] = vueOptions.methods[name].bind(instance);
        });
        Object.keys(vueOptions.computed).forEach(function (name) {
            Object.defineProperty(instance, name, {
                get: function () { return vueOptions.computed[name].call(instance); }
            });
        });
        vueOptions.mounted.call(instance);
        window.__aiVm = instance;
        return instance;
    };
    window.eval(aiSource);
    return { dom: dom, window: window, vm: window.__aiVm, editor: editor, state: state };
}

test('legacy browser key blocks fetch and custom driverRequest before either can run', function (t) {
    let callbackCalls = 0;
    const env = setup({
        ai: {
            driver: 'Proxy',
            driverConfig: { url: '/api/ai', csrfToken: 'session-token', key: 'old-browser-key' },
            driverRequest: function () { callbackCalls++; }
        }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system';
    env.vm.promptText = 'prompt';

    env.vm.doSubmit();

    assert.equal(env.state.fetchCalls.length, 0);
    assert.equal(callbackCalls, 0);
    assert.equal(env.vm.loading, false);
    assert.match(env.vm.resultError, /删除前端 Key/);
});

test('legacy direct provider names fail with migration guidance and do not request a provider', function (t) {
    const env = setup({
        ai: { driver: 'DeepSeek', driverConfig: { key: '' } }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system';

    env.vm.doSubmit();

    assert.equal(env.state.fetchCalls.length, 0);
    assert.equal(env.vm.loading, false);
    assert.match(env.vm.resultError, /浏览器直连模型驱动已停用/);
});

test('same-origin Proxy sends only prompts with session CSRF header and waits for user insertion', async function (t) {
    let tokenReads = 0;
    const eventBytes = Buffer.from('data: {"type":"data","data":"你"}\n\ndata: {"type":"end"}\n\n', 'utf8');
    const characterBytes = Buffer.from('你', 'utf8');
    const splitAt = eventBytes.indexOf(characterBytes) + 1;
    const env = setup({
        ai: {
            driver: 'Proxy',
            driverConfig: {
                url: '/api/ueditor/ai',
                csrfToken: function () { tokenReads++; return 'current-session-csrf'; }
            }
        },
        fetch: function () {
            return Promise.resolve(sseResponse([
                eventBytes.subarray(0, splitAt),
                eventBytes.subarray(splitAt)
            ]));
        }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system prompt';
    env.vm.promptText = 'document context';

    await env.vm.doSubmit();

    assert.equal(env.state.fetchCalls.length, 1);
    assert.equal(tokenReads, 1);
    const request = env.state.fetchCalls[0];
    assert.equal(request.url, 'https://editor.example.test/api/ueditor/ai');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.mode, 'same-origin');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.redirect, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(request.options.headers)), {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'current-session-csrf'
    });
    assert.deepEqual(JSON.parse(request.options.body), {
        systemPromptText: 'system prompt',
        promptText: 'document context'
    });
    assert.equal(/authorization|api.?key/i.test(JSON.stringify(request.options.headers)), false);
    assert.equal(/old-browser-key|api.?key/i.test(request.options.body), false);
    assert.equal(env.vm.resultText, '你');
    assert.equal(env.state.commands.length, 0, 'generation alone must not insert content');

    env.vm.doInsert();
    assert.equal(env.state.commands.length, 1);
    assert.equal(env.state.commands[0][0], 'insertHtml');
    assert.equal(env.state.commands[0][1], '你');
    assert.equal(env.state.events.filter(function (event) { return event === 'saveScene'; }).length, 2);
    assert.deepEqual(env.state.closeCalls, [true]);
});

test('SSE complete lines at chunk boundaries are delivered once and terminal finish releases the reader once', async function (t) {
    const lifecycle = { cancelPromise: Promise.reject(new Error('simulated cancel rejection')) };
    const chunks = [
        'data: {"type":"data","data":"A"}\n',
        '\ndata: {"type":"data","data":"B"}\n\ndata: {"type":"end"}\n\ndata: {"type":"end"}\n\n'
    ];
    const env = setup({
        ai: {
            driver: 'Proxy',
            driverConfig: { url: '/api/ai', csrfToken: 'session-token' }
        },
        fetch: function () { return Promise.resolve(sseResponse(chunks, lifecycle)); }
    });
    t.after(function () { env.dom.window.close(); });
    const originalSanitizer = env.window.UE.sanitizeHtml;
    let sanitizerCalls = 0;
    env.window.UE.sanitizeHtml = function (html) {
        sanitizerCalls++;
        return originalSanitizer(html);
    };
    env.vm.systemPromptText = 'system';

    await env.vm.doSubmit();
    await new Promise(function (resolve) { setImmediate(resolve); });

    assert.equal(env.vm.resultText, 'AB', 'the complete line at the first chunk tail is not replayed');
    assert.equal(env.vm.loading, false);
    assert.equal(sanitizerCalls, 1, 'duplicate end events do not run finish twice');
    assert.equal(lifecycle.readCalls, 2, 'the reader is not read after the terminal event');
    assert.equal(lifecycle.cancelCalls, 1);
    assert.equal(lifecycle.releaseCalls, 1);
});

test('SSE JSON fragments wait for the newline before parsing', async function (t) {
    const lifecycle = {};
    const env = setup({
        ai: {
            driver: 'Proxy',
            driverConfig: { url: '/api/ai', csrfToken: 'session-token' }
        },
        fetch: function () {
            return Promise.resolve(sseResponse([
                'data: {"type":"da',
                'ta","data":"fragmented"}\n\n',
                'data: {"type":"end"}\n\n'
            ], lifecycle));
        }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system';

    await env.vm.doSubmit();

    assert.equal(env.vm.resultText, 'fragmented');
    assert.equal(env.vm.resultError, '');
    assert.equal(env.vm.loading, false);
    assert.equal(lifecycle.cancelCalls, 1);
    assert.equal(lifecycle.releaseCalls, 1);
});

test('SSE EOF without an end marker reports failure, clears the partial result, and releases the reader', async function (t) {
    const lifecycle = {};
    const env = setup({
        ai: {
            driver: 'Proxy',
            driverConfig: { url: '/api/ai', csrfToken: 'session-token' }
        },
        fetch: function () {
            return Promise.resolve(sseResponse([
                'data: {"type":"data","data":"partial"}\n\n'
            ], lifecycle));
        }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system';

    await env.vm.doSubmit();

    assert.match(env.vm.resultError, /结束标记前关闭/);
    assert.equal(env.vm.resultText, '');
    assert.equal(env.vm.loading, false);
    assert.equal(lifecycle.readCalls, 2, 'the second read observes EOF');
    assert.equal(lifecycle.cancelCalls, 1);
    assert.equal(lifecycle.releaseCalls, 1);
});

test('custom driverRequest receives only prompts and remains an explicit host integration', function (t) {
    let captured;
    const env = setup({
        ai: {
            driver: 'HostAdapter',
            driverConfig: { key: '' },
            driverRequest: function (option) {
                captured = option;
                option.onStream({ code: 0, data: { text: 'generated' } });
                option.onFinish({ code: 0, data: { text: 'generated' } });
            }
        }
    });
    t.after(function () { env.dom.window.close(); });
    env.vm.systemPromptText = 'system';
    env.vm.promptText = 'prompt';

    env.vm.doSubmit();

    assert.equal(env.state.fetchCalls.length, 0);
    assert.equal(captured.systemPromptText, 'system');
    assert.equal(captured.promptText, 'prompt');
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'key'), false);
    assert.equal(env.vm.resultText, 'generated');
    assert.equal(env.state.commands.length, 0);
});

test('Proxy rejects empty, external, protocol-relative external, credentialed URLs and missing CSRF before fetch', function (t) {
    const invalidConfigs = [
        { url: '', csrfToken: 'token' },
        { url: 'https://outside.example/api', csrfToken: 'token' },
        { url: '//outside.example/api', csrfToken: 'token' },
        { url: 'https://user@editor.example.test/api', csrfToken: 'token' },
        { url: '/api/ai', csrfToken: '' }
    ];
    invalidConfigs.forEach(function (driverConfig) {
        const env = setup({ ai: { driver: 'Proxy', driverConfig: driverConfig } });
        t.after(function () { env.dom.window.close(); });
        env.vm.systemPromptText = 'system';
        env.vm.promptText = 'prompt';
        env.vm.doSubmit();
        assert.equal(env.state.fetchCalls.length, 0, JSON.stringify(driverConfig));
        assert.equal(env.vm.loading, false, JSON.stringify(driverConfig));
        assert.ok(env.vm.resultError, JSON.stringify(driverConfig));
    });
});

test('function prompts are copied per dialog and direct prompts do not reuse an earlier function prompt', function (t) {
    let captured;
    const configuredFunction = {
        name: 'rewrite',
        text: 'Rewrite',
        systemPrompt: 'rewrite system',
        prompt: 'Rewrite: {selectText}; source: {html}',
        param: { showInsert: true },
        enable: function () { return true; }
    };
    const env = setup({
        selectedText: 'first selection',
        aiFunctions: [configuredFunction],
        ai: {
            driver: 'HostAdapter',
            driverConfig: { key: '' },
            driverRequest: function (option) {
                captured = option;
                option.onFinish({ code: 0, data: { text: 'done' } });
            }
        }
    });
    t.after(function () { env.dom.window.close(); });

    assert.equal(configuredFunction.prompt, 'Rewrite: {selectText}; source: {html}');
    assert.equal(env.vm.functions[0].prompt, 'Rewrite: first selection; source: <p>current document</p>');
    env.vm.doSubmitFunction(env.vm.functions[0]);
    assert.equal(captured.promptText, 'Rewrite: first selection; source: <p>current document</p>');

    env.vm.promptText = 'old function prompt';
    env.vm.inputText = 'Write a conclusion';
    env.vm.doSubmitDirect();
    assert.equal(captured.systemPromptText, 'Write a conclusion');
    assert.equal(captured.promptText, 'first selection');
    assert.equal(configuredFunction.prompt, 'Rewrite: {selectText}; source: {html}');
});

test('prompt template preserves literal replacement tokens in selected text and document HTML', function (t) {
    const selectedText = 'selection $& and $` plus $\' suffix';
    const documentHtml = '<p>document $& and $` plus $\' suffix</p>';
    const configuredFunction = {
        prompt: 'Selected: {selectText}; Document: {html}',
        param: {},
        enable: function () { return true; }
    };
    const env = setup({
        selectedText: selectedText,
        content: documentHtml,
        aiFunctions: [configuredFunction],
        ai: { driver: 'HostAdapter', driverConfig: { key: '' }, driverRequest: function () {} }
    });
    t.after(function () { env.dom.window.close(); });

    assert.equal(
        env.vm.functions[0].prompt,
        'Selected: ' + selectedText + '; Document: ' + documentHtml
    );
    assert.equal(configuredFunction.prompt, 'Selected: {selectText}; Document: {html}');
});

test('HTML preview and multiline selected insertion sanitize dangerous attributes', function (t) {
    const env = setup({ selectedText: 'replace this' });
    t.after(function () { env.dom.window.close(); });
    env.vm.resultText = '<img src="x" onerror="alert(1)">\n<script>alert(2)</script><b>safe</b>';

    const preview = env.vm.resultHtml;
    assert.doesNotMatch(preview, /onerror|<script|alert\(/i);
    assert.match(preview, /safe/);

    assert.equal(env.vm.doReplace(), true);
    assert.equal(env.state.rangeState.deleted, 1);
    assert.equal(env.state.rangeState.inserted.length, 1);
    const fragment = env.state.rangeState.inserted[0];
    assert.equal(fragment.querySelector('[onerror]'), null);
    assert.equal(fragment.querySelector('script'), null);
    assert.equal(fragment.querySelector('b').textContent, 'safe');
    assert.equal(env.state.events.filter(function (event) { return event === 'saveScene'; }).length, 2);
});

test('single-line selected output uses a text node and replace-all uses sanitized HTML', function (t) {
    const env = setup({ selectedText: 'selected' });
    t.after(function () { env.dom.window.close(); });
    env.vm.resultText = '<img src=x onerror=alert(1)>';
    assert.equal(env.vm.doReplace(), true);
    const textNode = env.state.rangeState.inserted[0];
    assert.equal(textNode.nodeType, 3);
    assert.equal(textNode.nodeValue, '<img src=x onerror=alert(1)>');

    env.vm.resultText = '<img src=x onerror=alert(1)>\n<b>safe</b>';
    assert.equal(env.vm.doReplaceAll(), true);
    assert.equal(env.state.contents.length, 1);
    assert.doesNotMatch(env.state.contents[0], /onerror|<script/i);
    assert.match(env.state.contents[0], /safe/);

    env.vm.selectText = '';
    env.vm.resultText = '<img src=x onerror=alert(1)>';
    assert.equal(env.vm.doInsert(), true);
    assert.equal(env.state.commands.length, 1);
    assert.doesNotMatch(env.state.commands[0][1], /<img/i);
    assert.match(env.state.commands[0][1], /&lt;img/i);
});

test('missing sanitizer fails closed before preview and HTML insertion', function (t) {
    const env = setup({ sanitizer: false });
    t.after(function () { env.dom.window.close(); });
    env.vm.resultText = '<b>line one</b>\nline two';

    assert.equal(env.vm.resultHtml, '');
    assert.equal(env.vm.doInsert(), false);
    assert.equal(env.state.commands.length, 0);
    assert.equal(env.state.closeCalls.length, 0);
    assert.match(env.vm.resultError, /安全过滤器不可用/);

    env.vm.resultText = '<img src=x onerror=alert(1)>';
    assert.equal(env.vm.doInsert(), false);
    assert.equal(env.state.commands.length, 0);
});
