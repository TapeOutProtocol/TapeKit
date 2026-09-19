import { useEffect, useState } from 'react';
import { t, locale } from '../i18n';
import { type Message, type OpenedMessage, senderLabel , showsPending } from '../data/tapesend';

const palette = ['#0f7b55', '#2b6de8', '#b3541e', '#7a4fd6', '#b3261e', '#00796b', '#8a6d00'];
function colorFor(addr: string) {
  let h = 0;
  for (const c of addr) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

export function formatTime(seconds: number) {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return d.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
}

export function useLabel(container: string) {
  const [label, setLabel] = useState(`${container.slice(0, 6)}…${container.slice(-4)}`);
  useEffect(() => {
    let alive = true;
    void senderLabel(container).then((l) => alive && setLabel(l));
    return () => {
      alive = false;
    };
  }, [container]);
  return label;
}

function preview(o: OpenedMessage) {
  switch (o.status) {
    case 'ok':
      return (
        <>
          {o.subject ? <span className="subject">{o.subject}{' '}</span> : null}
          {o.body?.split('\n')[0]}
        </>
      );
    case 'locked':
      return t('locked');
    case 'not-for-key':
      return t('notForKey');
    case 'unsupported':
      return t('unsupported');
    default:
      return t('damaged');
  }
}

function Row({ m, o, isNew, onOpen }: { m: Message; o: OpenedMessage; isNew: boolean; onOpen: (m: Message) => void }) {
  const peer = m.direction === 'in' ? m.fromEndpoint : m.toEndpoint;
  const label = useLabel(peer);
  return (
    <li>
      <button className="msg" onClick={() => onOpen(m)}>
        <span className="avatar" style={{ background: colorFor(peer) }} aria-hidden>
          {label.replace(/^#/, '').slice(0, 2)}
        </span>
        <span className="who mono">{label}</span>
        <span className="when">
          {isNew ? <span className="chip" style={{ height: 20, marginRight: 6 }}>{t('newContact')}</span> : null}
          {showsPending(m) ? <span className="chip warn" style={{ height: 20, marginRight: 6 }}>{t('pending')}</span> : null}
          {o.kind === 'public' ? <span className="chip" style={{ height: 20, marginRight: 6 }}>{t('publicTag')}</span> : null}
          {formatTime(m.timestamp)}
        </span>
        <span className="preview">{preview(o)}</span>
      </button>
    </li>
  );
}

export function MessageList(props: {
  messages: Message[];
  opened: Map<string, OpenedMessage>;
  loading: boolean;
  emptyText: string;
  isNew: (m: Message) => boolean;
  onOpen: (m: Message) => void;
}) {
  if (props.loading && !props.messages.length) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }
  if (!props.messages.length) {
    return (
      <div className="empty">
        <p>{props.emptyText}</p>
        <p className="hint">{t('metadataPublic')}</p>
      </div>
    );
  }
  return (
    <ul className="messages">
      {props.messages.map((m) => (
        <Row key={m.id} m={m} o={props.opened.get(m.id) ?? { status: 'locked' }} isNew={props.isNew(m)} onOpen={props.onOpen} />
      ))}
    </ul>
  );
}
