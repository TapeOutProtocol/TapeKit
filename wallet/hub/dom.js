// Tiny DOM builder for the hub. Text is always inserted as text nodes (never parsed as HTML), so anything a
// site or a wallet supplies (messages, typed data, names) cannot inject markup. No inline styles: the hub CSP
// is style-src 'self', so only classes and the `hidden` attribute are used.

const BOOLEAN_PROPS = new Set(['hidden', 'disabled']);
const FORBIDDEN = new Set(['style', 'innerHTML', 'outerHTML', 'srcdoc', 'href', 'src']);

/**
 * el(doc, 'button', { class: 'plain', text: 'Reject', onclick: fn }, child, 'text', ...)
 * @param {Document} doc @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string|null|false)} children
 */
export function el(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (FORBIDDEN.has(key)) throw new TypeError(`dom: "${key}" is not allowed`);
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (BOOLEAN_PROPS.has(key)) node[key] = !!value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);   // strings become text nodes
  }
  return node;
}

/** Definition list of [label, value] rows; null values show `unknown`. */
export function rows(doc, pairs, unknown) {
  const list = el(doc, 'dl', { class: 'rows' });
  for (const [label, value, cls] of pairs) {
    list.append(el(doc, 'dt', { text: label }), el(doc, 'dd', { class: cls || '', text: value === null || value === undefined ? unknown : value }));
  }
  return list;
}
