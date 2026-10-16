// Offline unit tests for wallet/src/i18n.js: zh/en texts and error messages by code (R9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLang, tr, errorText, KEYS, LANGS } from '../src/i18n.js';
import { ERR } from '../src/protocol.js';

test('pickLang: Chinese locales get zh, everything else en', () => {
  for (const l of ['zh', 'zh-CN', 'zh-TW', 'ZH-hk']) assert.equal(pickLang(l), 'zh', l);
  for (const l of ['en-US', 'fr', '', undefined, null, 'zhx']) assert.equal(pickLang(l), 'en', String(l));
});

test('every key has a non-empty text in both languages with the same placeholders', () => {
  for (const key of KEYS) {
    const vars = LANGS.map((lang) => [...tr(lang, key).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join());
    assert.equal(vars[0], vars[1], key);
    for (const lang of LANGS) assert.ok(tr(lang, key).length > 0, `${lang} ${key}`);
  }
});

test('tr fills placeholders and leaves unknown ones visible', () => {
  assert.equal(tr('en', 'wallet.using', { wallet: 'OKX Wallet' }), 'Using OKX Wallet');
  assert.equal(tr('zh', 'wallet.using', { wallet: 'OKX Wallet' }), '正在使用 OKX Wallet');
  assert.equal(tr('en', 'wallet.using'), 'Using {wallet}');
  assert.equal(tr('en', 'no.such.key'), 'no.such.key');
  assert.equal(tr('en', 'constructor'), 'constructor', 'prototype keys are not texts');
});

test('every router error code has its own message in both languages', () => {
  for (const code of Object.values(ERR)) {
    for (const lang of LANGS) {
      const text = errorText(lang, code);
      assert.ok(text.length > 0);
      assert.ok(!text.includes(String(code)), `${lang} ${code} has a dedicated text`);
    }
  }
  assert.equal(errorText('en', 4001), 'You rejected the request.');
  assert.equal(errorText('zh', 'closed'), 'TapeKit 页面被关掉了，请求已取消。');
  assert.match(errorText('en', 'tab'), /browser tab/);
  assert.equal(errorText('en', 1234), 'The wallet returned an error (1234).');
});
