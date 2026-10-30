"use strict";

var aiConfig = editor.getOpt('ai') || {};
var aiFunctions = editor.getOpt('aiFunctions') || [];
var AI_PROXY_MIGRATION_ERROR = '浏览器端模型 Key 已停用。请从 driverConfig.key 删除前端 Key，并将模型 Key 迁移到同源服务端。';
var AI_LEGACY_DRIVER_ERROR = '浏览器直连模型驱动已停用。请改用同源 Proxy 或配置服务端 driverRequest。';
var AI_HTML_FILTER_ERROR = '安全过滤器不可用，无法显示或插入 AI 结果。';
var isMultiLine = function isMultiLine(text) {
  return /[\r\n]/.test(text);
};
var sanitizeAIHtml = function sanitizeAIHtml(html) {
  try {
    var sanitizer = window.parent && window.parent.UE && window.parent.UE.sanitizeHtml;
    if (typeof sanitizer !== 'function') {
      return null;
    }
    var sanitized = sanitizer(String(html));
    return typeof sanitized === 'string' ? sanitized : null;
  } catch (e) {
    return null;
  }
};
var getSanitizedResultHtml = function getSanitizedResultHtml(text, markdownConverter) {
  try {
    return sanitizeAIHtml(markdownConverter.makeHtml(String(text)));
  } catch (e) {
    return null;
  }
};
var escapeHtmlText = function escapeHtmlText(text) {
  var escaped = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return String(text).replace(/[&<>"']/g, function (character) {
    return escaped[character];
  });
};
var fetchStream = function fetchStream(url, option, onStream, onFinish) {
  var finished = false;
  var buffer = '';
  var textList = [];
  var decoder = new TextDecoder('utf-8');
  var reader;
  function finish(result) {
    if (finished) {
      return;
    }
    finished = true;
    if (reader) {
      var completedReader = reader;
      reader = null;
      try {
        var cancelResult = completedReader.cancel();
        if (cancelResult && typeof cancelResult["catch"] === 'function') {
          cancelResult["catch"](function () {});
        }
      } catch (e) {}
      try {
        if (typeof completedReader.releaseLock === 'function') {
          completedReader.releaseLock();
        }
      } catch (e) {}
    }
    onFinish(result);
  }
  function processDataLine(line) {
    line = line.trim();
    if (!line.startsWith('data:')) {
      return false;
    }
    var jsonStr = line.slice(5).trim();
    if (jsonStr === '[DONE]') {
      finish({
        code: 0,
        msg: 'ok',
        data: {
          text: textList.join('')
        }
      });
      return true;
    }
    var data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      finish({
        code: -1,
        msg: 'AI 代理返回了无效的流数据。'
      });
      return true;
    }
    if (data && data.type === 'error') {
      finish({
        code: -1,
        msg: String(data.data || 'AI 代理请求失败。')
      });
      return true;
    }
    if (data && data.type === 'end') {
      finish({
        code: 0,
        msg: 'ok',
        data: {
          text: textList.join('')
        }
      });
      return true;
    }
    var text = null;
    if (data && data.type === 'data') {
      text = data.data;
    } else if (data && data.choices && data.choices.length && data.choices[0].delta) {
      text = data.choices[0].delta.content;
      // OpenAI-compatible streams may include role-only deltas.
      if (text === undefined || text === null) {
        return false;
      }
    }
    if (typeof text !== 'string') {
      finish({
        code: -1,
        msg: 'AI 代理返回了不支持的流数据。'
      });
      return true;
    }
    textList.push(text);
    onStream({
      code: 0,
      msg: 'ok',
      data: {
        text: text
      }
    });
    return false;
  }
  function processBuffer(_final) {
    var lines = buffer.split(/\r?\n/);
    if (!_final) {
      buffer = lines.pop() || '';
    } else {
      buffer = '';
    }
    for (var i = 0; i < lines.length; i++) {
      if (processDataLine(lines[i])) {
        return true;
      }
    }
    return false;
  }
  function read() {
    return reader.read().then(function (result) {
      if (finished) {
        return;
      }
      if (result.done) {
        buffer += decoder.decode();
        processBuffer(true);
        if (!finished) {
          finish({
            code: -1,
            msg: 'AI 代理流在结束标记前关闭。'
          });
        }
        return;
      }
      buffer += decoder.decode(result.value, {
        stream: true
      });
      processBuffer(false);
      if (!finished) {
        return read();
      }
    });
  }
  var request;
  try {
    request = fetch(url, option);
  } catch (error) {
    finish({
      code: -1,
      msg: 'AI 代理请求失败。'
    });
    return null;
  }
  return Promise.resolve(request).then(function (response) {
    if (!response.ok) {
      finish({
        code: -1,
        msg: 'AI 代理请求失败，HTTP 状态：' + response.status
      });
      return;
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      finish({
        code: -1,
        msg: 'AI 代理没有返回 SSE 流。'
      });
      return;
    }
    reader = response.body.getReader();
    return read();
  })["catch"](function () {
    finish({
      code: -1,
      msg: 'AI 代理连接中断。'
    });
  });
};
var resolveProxyUrl = function resolveProxyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请明确配置同源 AI 代理 URL。');
  }
  var parsed;
  try {
    parsed = new window.URL(value.trim(), window.location.href);
  } catch (e) {
    throw new Error('AI 代理 URL 无效。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('AI 代理 URL 不能包含用户名或密码。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' || parsed.origin !== window.location.origin) {
    throw new Error('AI 代理 URL 必须与编辑器页面同源。');
  }
  return parsed.href;
};
var readCsrfToken = function readCsrfToken(config) {
  var token;
  try {
    token = config.csrfToken;
    if (typeof token === 'function') {
      token = token.call(config);
    }
  } catch (e) {
    throw new Error('无法读取 AI 代理所需的 CSRF token。');
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('请配置与当前会话绑定的 CSRF token。');
  }
  return token.trim();
};
var proxyCompletion = function proxyCompletion(param) {
  var config = aiConfig.driverConfig || {};
  var url;
  var csrfToken;
  try {
    url = resolveProxyUrl(config.url);
    csrfToken = readCsrfToken(config);
  } catch (error) {
    param.onFinish({
      code: -1,
      msg: error.message
    });
    return null;
  }
  return fetchStream(url, {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({
      systemPromptText: param.systemPromptText,
      promptText: param.promptText
    })
  }, param.onStream, param.onFinish);
};
var legacyDrivers = ['ModStart', 'OpenAi', 'DeepSeek', 'Anthropic', 'Google', 'Baidu', 'Alibaba', 'Tencent', 'Huawei', 'ByteDance', 'Zhipu', 'Moonshot', 'iFlytek', 'Volcengine'];
function getRequest(driver) {
  if (typeof aiConfig.driverRequest === 'function') {
    return aiConfig.driverRequest;
  }
  if (driver === 'Proxy') {
    return proxyCompletion;
  }
  if (legacyDrivers.indexOf(driver) !== -1) {
    return function (param) {
      param.onFinish({
        code: -1,
        msg: AI_LEGACY_DRIVER_ERROR
      });
    };
  }
  return null;
}
var converter = new window.showdown.Converter();
var AiDefaultAiFunctionParam = {
  showInsert: true,
  showReplace: true,
  showReplaceAll: false
};
var Ai = {
  runtime: {
    range: null
  },
  init: function init() {
    new Vue({
      el: '#app',
      data: {
        loading: false,
        selectText: '',
        inputText: '',
        submitFunction: null,
        systemPromptText: '',
        promptText: '',
        resultText: '',
        resultError: '',
        functions: [],
        showInsert: AiDefaultAiFunctionParam.showInsert,
        showReplace: AiDefaultAiFunctionParam.showReplace,
        showReplaceAll: AiDefaultAiFunctionParam.showReplaceAll
      },
      mounted: function mounted() {
        Ai.runtime.range = editor.selection.getRange();
        var cloneContents = Ai.runtime.range.cloneContents();
        if (cloneContents) {
          this.selectText = cloneContents.textContent.trim();
        } else {
          this.selectText = '';
        }
        this.buildFunctions();
      },
      computed: {
        resultHtml: function resultHtml() {
          if (!this.resultText) {
            return '';
          }
          var html = getSanitizedResultHtml(this.resultText, converter);
          return html === null ? '' : html;
        },
        resultHeight: function resultHeight() {
          var height = 255;
          if (this.selectText) {
            height -= 45;
          }
          if (this.resultError) {
            height -= 45;
          }
          return height + 'px';
        }
      },
      methods: {
        buildFunctions: function buildFunctions() {
          var enableParam = {
            selectText: this.selectText
          };
          this.functions = aiFunctions.map(function (f) {
            if (!f.enable(enableParam)) {
              return null;
            }
            var prompt = String(f.prompt || '');
            prompt = prompt.replace(/\{selectText\}/g, function () {
              return enableParam.selectText;
            });
            var html = editor.getContent();
            prompt = prompt.replace(/\{html\}/g, function () {
              return html;
            });
            return Object.assign({}, f, {
              prompt: prompt,
              param: Object.assign({}, AiDefaultAiFunctionParam, f.param)
            });
          }).filter(function (f) {
            return !!f;
          });
        },
        doSubmit: function doSubmit() {
          if (this.loading) {
            return null;
          }
          this.resultError = '';
          var driverConfig = aiConfig.driverConfig || {};
          if (driverConfig.key !== undefined && driverConfig.key !== null && String(driverConfig.key).length > 0) {
            this.resultError = AI_PROXY_MIGRATION_ERROR;
            editor.tipError(AI_PROXY_MIGRATION_ERROR);
            return null;
          }
          if (!this.systemPromptText) {
            editor.tipError('请输入系统提示语');
            return null;
          }
          var driverRequest = getRequest(aiConfig.driver);
          if (!driverRequest) {
            this.resultError = '未找到驱动';
            editor.tipError(this.resultError);
            return null;
          }
          this.loading = true;
          this.resultText = '';
          var self = this;
          try {
            return driverRequest({
              systemPromptText: this.systemPromptText,
              promptText: this.promptText,
              onStream: function onStream(res) {
                if (res.code) {
                  self.resultError = res.msg;
                  self.loading = false;
                  self.resultText = '';
                  return;
                }
                self.resultText += String(res.data && res.data.text || '');
              },
              onFinish: function onFinish(res) {
                self.loading = false;
                if (res.code) {
                  self.resultError = res.msg;
                  self.resultText = '';
                  return;
                }
                self.resultText = String(res.data && res.data.text || '');
                if (self.resultText && getSanitizedResultHtml(self.resultText, converter) === null) {
                  self.resultError = AI_HTML_FILTER_ERROR;
                }
              }
            });
          } catch (e) {
            this.loading = false;
            this.resultError = 'AI 请求失败。';
            editor.tipError(this.resultError);
            return null;
          }
        },
        doSubmitFunction: function doSubmitFunction(f) {
          this.submitFunction = f;
          this.systemPromptText = f.systemPrompt || '';
          this.promptText = f.prompt || '';
          this.showInsert = f.param.showInsert;
          this.showReplace = f.param.showReplace;
          this.showReplaceAll = f.param.showReplaceAll;
          return this.doSubmit();
        },
        doSubmitDirect: function doSubmitDirect() {
          this.submitFunction = null;
          this.systemPromptText = this.inputText || '';
          this.promptText = this.selectText || '';
          if (!this.systemPromptText) {
            editor.tipError('请输入系统提示语');
            return null;
          }
          this.showInsert = AiDefaultAiFunctionParam.showInsert;
          this.showReplace = AiDefaultAiFunctionParam.showReplace;
          this.showReplaceAll = AiDefaultAiFunctionParam.showReplaceAll;
          return this.doSubmit();
        },
        getInsertError: function getInsertError() {
          this.resultError = AI_HTML_FILTER_ERROR;
          editor.tipError(AI_HTML_FILTER_ERROR);
          return false;
        },
        doInsert: function doInsert() {
          var multiLine = isMultiLine(this.resultText);
          var safeHtml = multiLine ? getSanitizedResultHtml(this.resultText, converter) : this.selectText ? null : sanitizeAIHtml(escapeHtmlText(this.resultText));
          if ((multiLine || !this.selectText) && safeHtml === null) {
            return this.getInsertError();
          }
          editor.fireEvent('saveScene');
          if (this.selectText) {
            if (multiLine) {
              Ai.runtime.range.insertNode(document.createRange().createContextualFragment(safeHtml));
            } else {
              Ai.runtime.range.insertNode(document.createTextNode(this.resultText));
            }
          } else if (multiLine) {
            editor.execCommand('insertHtml', safeHtml);
          } else {
            editor.execCommand('insertHtml', safeHtml);
          }
          editor.fireEvent('saveScene');
          dialog.close(true);
          return true;
        },
        doReplace: function doReplace() {
          var multiLine = isMultiLine(this.resultText);
          var safeHtml = multiLine ? getSanitizedResultHtml(this.resultText, converter) : null;
          if (multiLine && safeHtml === null) {
            return this.getInsertError();
          }
          editor.fireEvent('saveScene');
          Ai.runtime.range.deleteContents();
          if (multiLine) {
            Ai.runtime.range.insertNode(document.createRange().createContextualFragment(safeHtml));
          } else {
            Ai.runtime.range.insertNode(document.createTextNode(this.resultText));
          }
          editor.fireEvent('saveScene');
          dialog.close(true);
          return true;
        },
        doReplaceAll: function doReplaceAll() {
          var safeHtml = getSanitizedResultHtml(this.resultText, converter);
          if (safeHtml === null) {
            return this.getInsertError();
          }
          editor.fireEvent('saveScene');
          editor.setContent(safeHtml);
          editor.fireEvent('saveScene');
          dialog.close(true);
          return true;
        }
      }
    });
  }
};
utils.domReady(function () {
  Ai.init();
});
