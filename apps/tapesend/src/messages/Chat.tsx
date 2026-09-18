import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t, locale } from '../i18n';
import { IconBack, IconBellOff, IconMore, IconReload } from '../icons';
import {
  type Conversation, type Endpoint, type Hex, type Message, type OpenedMessage, canSeal, chainName, endpointContainer, isHomeEndpoint, messageSender, notePeerSender, peerHolder, resolveEndpoint,
} from '../data/tapesend';
import { parseEndpointId } from '../../../../send/module/src/chain.js';
import { formatTime, useLabel } from './MessageList';
import { Compose } from './Compose';
import { AttachmentView } from './Attachments';

const palette = ['#0f7b55', '#2b6de8', '#b3541e', '#7a4fd6', '#b3261e', '#00796b', '#8a6d00'];
export function colorFor(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function Avatar({ label, peer, size = 44, onClick }: { label: string; peer: string; size?: number; onClick?: () => void }) {
  const style = { background: peer === 'me' ? 'var(--accent)' : colorFor(peer), width: size, height: size };
  const text = label.replace(/^#/, '').slice(0, 2);
  if (onClick) {
    return (
      <button type="button" className="avatar avatar-btn" style={style} onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={t('profileOpen').replace('{who}', label)}>
        {text}
      </button>
    );
  }
  return <span className="avatar" style={style} aria-hidden>{text}</span>;
}

const explorer = (chainId: number) => (chainId === 56 ? 'https://bscscan.com' : chainId === 8453 ? 'https://basescan.org' : chainId === 196 ? 'https://www.oklink.com/xlayer' : '');

/** 点头像弹出：这个端点的电路容器信息。me 传自己的端点（已读到），否则按端点号现读链上 */
export function ProfileModal({ endpoint, me, onClose }: { endpoint: string; me?: Endpoint; onClose: () => void }) {
  const [ep, setEp] = useState<Endpoint | null>(me ?? null);
  const [state, setState] = useState<'loading' | 'ok' | 'failed' | 'other-chain'>(me ? 'ok' : 'loading');
  const [copied, setCopied] = useState('');
  const parsed = parseEndpointId(endpoint);
  useEffect(() => {
    if (me || !parsed) return;
    if (!isHomeEndpoint(endpoint)) { setState('other-chain'); return; }
    let alive = true;
    resolveEndpoint(parsed.container).then((r) => {
      if (!alive) return;
      if (r.endpoint) { setEp(r.endpoint); setState('ok'); } else setState('failed');
    }).catch(() => alive && setState('failed'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);
  const copy = (v: string) => { void navigator.clipboard?.writeText(v); setCopied(v); setTimeout(() => setCopied(''), 1200); };
  const chainId = parsed?.chainId ?? 56;
  const base = explorer(chainId);
  const Row = ({ k, v, link, mono = true }: { k: string; v: string; link?: string; mono?: boolean }) => (
    <div className="profile-row">
      <span className="profile-k">{k}</span>
      <span className={`profile-v ${mono ? 'mono' : ''}`}>
        {link ? <a href={link} target="_blank" rel="noopener noreferrer">{v}</a> : v}
        {mono ? <button className="profile-copy" onClick={() => copy(v)}>{copied === v ? t('copied') : t('copy')}</button> : null}
      </span>
    </div>
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal profile" onClick={(e) => e.stopPropagation()} role="dialog">
        {state === 'loading' ? <div className="empty" style={{ padding: 24 }}><span className="spinner" /></div> : null}
        {state === 'failed' ? <p className="hint bad">{t('profileFailed')}</p> : null}
        {state === 'other-chain' && parsed ? (
          <>
            <h3 className="mono">{chainName(chainId)}</h3>
            <Row k={t('profileContainer')} v={parsed.container} />
            <p className="hint">{t('chatOtherChain')}</p>
          </>
        ) : null}
        {state === 'ok' && ep ? (
          <>
            <div className="profile-head">
              <Avatar label={ep.label} peer={me ? 'me' : endpoint} size={52} />
              <div>
                <h3 className="mono" style={{ margin: 0 }}>{ep.label}</h3>
                <div className="hint">{chainName(ep.chainId)}{me ? ` ${t('chatSelf')}` : ''}</div>
              </div>
            </div>
            <div className="profile-rows">
              <Row k={t('profileId')} v={ep.label} />
              {ep.name ? <Row k={t('profileName')} v={ep.name} /> : null}
              <Row k={t('profileContainer')} v={ep.container} link={base ? `${base}/address/${ep.container}` : undefined} />
              <Row k={t('profileCircuits')} v={ep.circuits} link={base ? `${base}/address/${ep.circuits}` : undefined} />
              <Row k={t('profileCpu')} v={ep.cpu.toString()} mono={false} />
              <Row k={t('profileToken')} v={`#${ep.tokenId.toString()}`} mono={false} />
              {ep.holder ? <Row k={t('profileHolder')} v={ep.holder} link={base ? `${base}/address/${ep.holder}` : undefined} /> : null}
              <Row k={t('profileKey')} v={canSeal(ep) ? t('profileKeyOk') : ep.opened ? t('profileKeyNone') : t('recipientUnopened')} mono={false} />
              <Row k={t('profileEndpoint')} v={ep.endpoint} />
            </div>
          </>
        ) : null}
        <div className="actions"><button className="btn primary" onClick={onClose}>{t('close')}</button></div>
      </div>
    </div>
  );
}

/** 列表里一行的预览文字 */
function previewText(o: OpenedMessage | undefined): string {
  if (!o) return t('locked');
  switch (o.status) {
    case 'ok': return (o.subject ? `${o.subject} ` : '') + (o.body ?? '').split('\n')[0];
    case 'locked': return t('locked');
    case 'not-for-key': return t('notForKey');
    case 'unsupported': return t('unsupported');
    default: return t('damaged');
  }
}

function ConversationRow({ c, me, opened, isNew, onOpen }: {
  c: Conversation; me: Endpoint; opened: Map<string, OpenedMessage>; isNew: boolean; onOpen: (peer: Hex) => void;
}) {
  const label = useLabel(c.peer);
  const mine = c.last.fromEndpoint.toLowerCase() === me.endpoint.toLowerCase();
  const self = c.peer.toLowerCase() === me.endpoint.toLowerCase();
  return (
    <li>
      <button className="convo" onClick={() => onOpen(c.peer)}>
        <Avatar label={label} peer={c.peer} />
        <span className="convo-main">
          <span className="convo-top">
            <span className="who mono">{self ? `${me.label} ${t('chatSelf')}` : label}</span>
            <span className="when">{formatTime(c.last.timestamp)}</span>
          </span>
          <span className="convo-bottom">
            <span className="preview">{mine && !self ? `${t('chatYou')}: ` : ''}{previewText(opened.get(c.last.id))}</span>
            {isNew ? <span className="chip">{t('newContact')}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ConversationList({ conversations, me, opened, loading, isNew, onOpen }: {
  conversations: Conversation[];
  me: Endpoint;
  opened: Map<string, OpenedMessage>;
  loading: boolean;
  isNew: (peer: Hex) => boolean;
  onOpen: (peer: Hex) => void;
}) {
  if (loading && !conversations.length) {
    return <div className="empty"><span className="spinner" /></div>;
  }
  if (!conversations.length) {
    return (
      <div className="empty">
        <p>{t('chatEmpty')}</p>
        <p className="hint">{t('metadataPublic')}</p>
      </div>
    );
  }
  return (
    <ul className="convos">
      {conversations.map((c) => (
        <ConversationRow key={c.peer} c={c} me={me} opened={opened} isNew={isNew(c.peer)} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function dayLabel(seconds: number) {
  const d = new Date(seconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t('today');
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('yesterday');
  return d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

const fullTime = (seconds: number) => new Date(seconds * 1000).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Card({ m, o, mine, meLabel, peerLabel, peer, replyTo, collapsed, onToggle, onProfile, onQuote }: {
  m: Message; o: OpenedMessage | undefined; mine: boolean; meLabel: string; peerLabel: string; peer: string;
  onProfile: (mine: boolean) => void;
  onQuote?: () => void;
  /** 这条回复的是会话里的哪一条（按 ref 找到时） */
  replyTo?: { who: string; text: string };
  collapsed: boolean;
  onToggle: () => void;
}) {
  const ok = o?.status === 'ok';
  const who = mine ? meLabel : peerLabel;
  // 卡片头部显示：自己一律写"我"，对方写电路 ID（头像仍用电路 ID 的前两位）
  const whoText = mine ? t('chatYou') : peerLabel;
  const toText = mine ? peerLabel : t('chatYou');
  return (
    <article className={`tl-item ${mine ? 'mine' : 'theirs'}`}>
      <span className="tl-dot"><Avatar label={who} peer={mine ? 'me' : peer} size={32} onClick={() => onProfile(mine)} /></span>
      <div className={`tl-card ${collapsed ? 'collapsed' : ''}`} onClick={collapsed ? onToggle : undefined}>
        <header className="tl-head" onClick={collapsed ? undefined : onToggle}>
          <span className="tl-who">
            <b className="mono">{whoText}</b>
            {!collapsed ? <span className="tl-to"> → <span className="mono">{toText}</span></span> : null}
          </span>
          <span className="tl-when">
            {o?.kind === 'public' ? <span className="bubble-tag">{t('publicTag')}</span> : null}
            {m.copies && m.copies > 1 ? <span className="bubble-tag" title={t('chatDuplicateTitle')}>×{m.copies}</span> : null}
            {fullTime(m.timestamp)}
          </span>
        </header>
        {collapsed ? (
          <div className="tl-preview">{previewText(o)}</div>
        ) : (
          <>
            {replyTo ? (
              <div className="tl-quote">
                <span className="tl-quote-who">{t('chatReplyTo').replace('{who}', replyTo.who)}</span>
                <span className="tl-quote-text">{replyTo.text}</span>
              </div>
            ) : null}
            {ok && o.subject ? <h3 className="tl-subject">{o.subject}</h3> : null}
            {ok && !o.body && o.attachments?.length ? null : <div className={`tl-body ${ok ? '' : 'muted-text'}`}>{ok ? o.body : previewText(o)}</div>}
            {ok && o.attachments?.length ? <AttachmentView list={o.attachments} m={m} /> : null}
            {ok && o.badAttachments ? <div className="hint bad">{t('attachBad').replace('{n}', String(o.badAttachments))}</div> : null}
            <footer className="tl-foot">
              <span className="grow">
                {chainName(m.chainId)} {t('chatBlock')} #{m.blockNumber}
                {m.pending ? ` ${t('pending')}` : ''}
                {m.copies && m.copies > 1 ? ` ${t('chatDuplicate').replace('{n}', String(m.copies))}` : ''}
              </span>
              {onQuote ? <button className="tl-quote-btn" onClick={(e) => { e.stopPropagation(); onQuote(); }}>{t('quoteReply')}</button> : null}
            </footer>
          </>
        )}
      </div>
    </article>
  );
}

/** 邮件卡片 + 时间线：从旧到新，按天分隔；较早的消息折叠成一行，点开展开 */
export function ThreadTimeline({ me, peer, messages, opened, meLabel, peerLabel, onProfile, onQuote }: {
  me: Endpoint; peer: string; messages: Message[]; opened: Map<string, OpenedMessage>; meLabel: string; peerLabel: string;
  onProfile: (mine: boolean) => void;
  onQuote?: (m: Message) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const byId = new Map(messages.map((m) => [m.id.toLowerCase(), m]));
  const openCount = 3; // 最近几条默认展开
  // 对方每条消息是哪个钱包发的（按消息交易本身核对）：钱包变了，说明对方的电路换了持有人，插一条提示
  const [senders, setSenders] = useState<Map<string, string>>(new Map());
  // 不是持有人钱包直接发出的消息（经过别的合约、或同一笔交易里转移过 NFT）：可能是被授权的合约借走电路代发的
  const [indirect, setIndirect] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const theirs = messages.filter((m) => m.fromEndpoint.toLowerCase() !== me.endpoint.toLowerCase()).slice(-30);
    for (const m of theirs) {
      void messageSender(m).then((w) => {
        if (alive && w === 'indirect') setIndirect((cur) => (cur.has(m.id) ? cur : new Set(cur).add(m.id)));
        if (alive && w && w !== 'indirect') setSenders((cur) => (cur.get(m.id) === w ? cur : new Map(cur).set(m.id, w)));
      });
    }
    return () => { alive = false; };
  }, [messages, me.endpoint]);
  // 起点用本机记住的对方钱包（打开会话时读一次）：对方旧消息不在已加载的页里、或新主人连发几十条，也能发现换主
  const peerContainer = endpointContainer(peer) ?? peer.toLowerCase();
  const [remembered] = useState(() => peerHolder(me.container, peerContainer));
  useEffect(() => {
    const first = messages.find((m) => senders.has(m.id));
    if (first) notePeerSender(me.container, peerContainer, senders.get(first.id)!);
  }, [senders, messages, me.container, peerContainer]);
  const holderChanged = new Set<string>();
  let lastWallet: string | undefined = remembered ?? undefined;
  for (const m of messages) {
    const w = senders.get(m.id);
    if (!w) continue;
    if (lastWallet && w !== lastWallet) holderChanged.add(m.id);
    lastWallet = w;
  }
  return (
    <div className="timeline">
      {messages.map((m, i) => {
        const mine = m.fromEndpoint.toLowerCase() === me.endpoint.toLowerCase();
        const day = dayLabel(m.timestamp);
        const newDay = i === 0 || dayLabel(messages[i - 1]!.timestamp) !== day;
        const parent = /^0x0{64}$/.test(m.ref) ? undefined : byId.get(m.ref.toLowerCase());
        const replyTo = parent ? {
          who: parent.fromEndpoint.toLowerCase() === me.endpoint.toLowerCase() ? t('chatYou') : peerLabel,
          text: previewText(opened.get(parent.id)),
        } : undefined;
        const collapsed = i < messages.length - openCount && !expanded.has(m.id);
        return (
          <div key={m.id}>
            {newDay ? <div className="day-sep"><span>{day}</span></div> : null}
            {holderChanged.has(m.id) ? <div className="holder-changed">{t('chatHolderChanged')}</div> : null}
            {indirect.has(m.id) ? <div className="holder-changed">{t('chatIndirectSender')}</div> : null}
            <Card
              m={m} o={opened.get(m.id)} mine={mine} meLabel={meLabel} peerLabel={peerLabel} peer={peer}
              replyTo={replyTo} collapsed={collapsed} onProfile={onProfile}
              onQuote={onQuote && !m.pending ? () => onQuote(m) : undefined}
              onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ChatThread({ me, wallet, peer, messages, opened, muted, halted, isNew, onClose, onMute, onIdentity, onSent, onRefresh, refreshing }: {
  me: Endpoint;
  wallet: Hex;
  peer: Hex;
  /** 从旧到新 */
  messages: Message[];
  opened: Map<string, OpenedMessage>;
  muted: boolean;
  halted: boolean;
  isNew: boolean;
  onClose: () => void;
  onMute: (muted: boolean) => void;
  onIdentity: (e: Endpoint) => void;
  onSent: (warning?: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  // 刚发出的消息：链上已经成功，但列表要过几秒才同步到；这段时间显示"已发送，正在同步"
  const [justSent, setJustSent] = useState<{ count: number; at: number } | null>(null);
  useEffect(() => {
    if (justSent && (messages.length > justSent.count || Date.now() - justSent.at > 90_000)) setJustSent(null);
  }, [messages.length, justSent]);
  const self = peer.toLowerCase() === me.endpoint.toLowerCase();
  const resolved = useLabel(peer);
  // 和自己的会话：直接用自己的完整 ID，不去链上反查
  const label = self ? me.label : resolved;
  const [profile, setProfile] = useState<null | 'me' | 'peer'>(null);
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const container = endpointContainer(peer);
  const home = isHomeEndpoint(peer);

  // 打开和有新消息时滚到最底部
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);


  return (
    <div className="sheet chat" role="dialog" aria-label={label}>
      <div className="sheet-head chat-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('back')}><IconBack /></button>
        <Avatar label={label} peer={self ? 'me' : peer} size={36} onClick={() => setProfile(self ? 'me' : 'peer')} />
        <span className="grow chat-title">
          <b className="mono">{label}</b>
          <span className="chat-sub">
            {muted ? <><IconBellOff /> {t('chatMuted')}{' '}</> : null}
            {isNew ? `${t('newContact')} ` : ''}
            {t('chatAs').replace('{me}', me.label)} {t('chatEncrypted')}
          </span>
        </span>
        <button className="icon-btn" onClick={onRefresh} disabled={refreshing} aria-label={t('reload')} title={t('reload')}>{refreshing ? <span className="spinner" /> : <IconReload />}</button>
        <div className="menu-anchor">
          <button className="icon-btn" onClick={() => setMenu((v) => !v)} aria-label={t('more')} aria-expanded={menu}><IconMore /></button>
          {menu ? (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => { setMenu(false); onMute(!muted); }}>
                  {muted ? t('unmute') : t('muteContact')}
                  <span className="menu-hint">{muted ? t('unmuteHint') : t('muteHint')}</span>
                </button>
                {container ? (
                  <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(container); setCopied(true); setMenu(false); }}>
                    {t('copyAddress')}
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="chat-scroll" ref={scroller}>
        <div className="chat-inner">
          <p className="chat-banner">{t('metadataPublic')}</p>
          <ThreadTimeline me={me} peer={peer} messages={messages} opened={opened} meLabel={me.label} peerLabel={label} onProfile={(mine) => setProfile(mine || self ? 'me' : 'peer')} onQuote={home && !halted ? setQuoting : undefined} />
          {justSent ? <div className="sent-syncing"><span className="spinner" /> {t('sentSyncing')}</div> : null}
          {copied ? <div className="toast">{t('copied')}</div> : null}
        </div>
      </div>

      {profile ? <ProfileModal endpoint={profile === 'me' ? me.endpoint : peer} me={profile === 'me' ? me : undefined} onClose={() => setProfile(null)} /> : null}

      {home && container && !halted ? (
        <Compose
          variant="inline"
          me={me}
          wallet={wallet}
          initial={{ to: container, ref: quoting?.id }}
          quote={quoting ? { who: quoting.fromEndpoint.toLowerCase() === me.endpoint.toLowerCase() ? t('chatYou') : label, text: previewText(opened.get(quoting.id)) } : null}
          onClearQuote={() => setQuoting(null)}
          onIdentity={onIdentity}
          onClose={onClose}
          onSent={(w) => { setQuoting(null); setJustSent({ count: messages.length, at: Date.now() }); onSent(w); }}
        />
      ) : (
        <div className="chat-compose"><p className="hint" style={{ margin: 0, textAlign: 'center' }}>{halted ? t('circuitsChanged') : t('chatOtherChain')}</p></div>
      )}
    </div>
  );
}
