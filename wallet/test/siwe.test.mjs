// Offline unit tests for wallet/src/siwe.js: read the domain line of an EIP-4361 message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSiweDomain, siweMismatch } from '../src/siwe.js';

const ADDR = '0x' + 'aa'.repeat(20);
const siwe = (domain) => `${domain} wants you to sign in with your Ethereum account:\n${ADDR}\n\nSign in to the app.\n\nURI: https://${domain}\nVersion: 1\nChain ID: 56\nNonce: 32891756\nIssued At: 2026-10-08T00:00:00Z`;
const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');

test('reads the domain from a plain-text SIWE message', () => {
  assert.equal(parseSiweDomain(siwe('4246-0.tapekit.org')), '4246-0.tapekit.org');
  assert.equal(parseSiweDomain(siwe('4246-0.localhost:8096')), '4246-0.localhost:8096');
});

test('reads the domain from a 0x-hex personal_sign payload', () => {
  assert.equal(parseSiweDomain(hex(siwe('evil.com'))), 'evil.com');
  assert.equal(parseSiweDomain(hex(siwe('evil.com')).toUpperCase().replace('0X', '0x')), 'evil.com');
});

test('accepts CRLF line ends and the optional scheme prefix', () => {
  assert.equal(parseSiweDomain(siwe('example.com').replace(/\n/g, '\r\n')), 'example.com');
  assert.equal(parseSiweDomain(siwe('https://example.com')), 'example.com');
});

test('returns null for ordinary messages', () => {
  for (const m of ['hello', '', 'Sign this to log in', `example.com wants you to sign in with your Ethereum account`, `\n${siwe('a.com')}`,
    hex('hello world'), '0x', '0xzz', 'evil.com  wants you to sign in with your Ethereum account:\nx', null, undefined, 42, {}]) {
    assert.equal(parseSiweDomain(m), null, String(m));
  }
});

test('returns null for hex that is not valid UTF-8', () => {
  assert.equal(parseSiweDomain('0xff' + hex(siwe('evil.com')).slice(2)), null);
});

test('siweMismatch flags SIWE messages for another host only', () => {
  assert.equal(siweMismatch(siwe('evil.com'), '4246-0.tapekit.org'), true);
  assert.equal(siweMismatch(hex(siwe('4246-0.tapekit.org')), '4246-0.tapekit.org'), false);
  assert.equal(siweMismatch(siwe('4246-0.TapeKit.org'), '4246-0.tapekit.org'), false, 'host compare is case-insensitive');
  assert.equal(siweMismatch(siwe('4246-0.tapekit.org:443'), '4246-0.tapekit.org'), true, 'ports must match exactly');
  assert.equal(siweMismatch('just a message', '4246-0.tapekit.org'), false);
});
