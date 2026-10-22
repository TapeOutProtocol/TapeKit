// Sign-In with Ethereum (EIP-4361) domain check (design §5.2, threat table §11).
// Neither OKX nor Binance parses SIWE messages (research/wallets.md §3 item 4), and through the hub they
// would only see the hub origin anyway. So the hub reads the first line itself and warns when the
// message asks to sign in to a host other than the requesting site. Only the first line is parsed.

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const FIRST_LINE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(\S+) wants you to sign in with your Ethereum account:$/;
const MAX_LINE = 1024;

/** personal_sign payloads are usually 0x-hex of UTF-8 bytes. Returns the text, or null if not valid UTF-8. */
export function messageText(message) {
  if (typeof message !== 'string') return null;
  if (!HEX.test(message)) return message;
  const bytes = new Uint8Array((message.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(message.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Domain (RFC 3986 authority) of an EIP-4361 message, or null when the message is not SIWE. */
export function parseSiweDomain(message) {
  const text = messageText(message);
  if (!text) return null;
  const line = text.split(/\r?\n/, 1)[0];
  if (line.length > MAX_LINE) return null;
  const m = FIRST_LINE.exec(line);
  return m ? m[1] : null;
}

/** True when the message is a SIWE message for a different host than `siteHost` (host[:port]). */
export function siweMismatch(message, siteHost) {
  const domain = parseSiweDomain(message);
  return domain !== null && domain.toLowerCase() !== String(siteHost).toLowerCase();
}
