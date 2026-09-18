import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useConfig, usePublicClient, useSendTransaction } from 'wagmi';
import { signMessage } from '@wagmi/core';
import { bsc } from 'wagmi/chains';
import { t } from '../i18n';
import { IconLock, IconPen, IconReload } from '../icons';
import { hasAppKit, keySigningBlocked, openWalletModal } from '../wallet/config';
import {
  type Endpoint, type ExpectedLog, type Hex, type Message, type MoreToken, HUB_TOPICS, boxCounts, endpointContainer, groupConversations, mergeMessages, addContacts, contacts, clearKeys, confirmTx, currentKeyUnlocked, knownPeer, listMessages, mutedSenders,
  openMessage, publishKeyTx, resolveEndpoint, revokeKeyTx, setMuted, unlock,
} from '../data/tapesend';
import { IdentityPicker } from './IdentityPicker';
import { ChatThread, ConversationList } from './Chat';
import { AssetsSheet } from './Assets';
import { Compose } from './Compose';

type KeyState = 'idle' | 'working' | 'publishing' | 'confirming' | 'nondeterministic' | 'mismatch' | 'blocked' | 'account-changed' | 'reverted' | 'replaced' | 'unknown' | 'not-visible' | 'publish-unknown';

/** 用户在钱包里点了拒绝（不是超时或网络错误） */
const isUserRejection = (e: unknown) => {
  const x = e as { name?: string; code?: number; cause?: { code?: number }; message?: string } | null;
  return Boolean(x && (x.name === 'UserRejectedRequestError' || x.code === 4001 || x.cause?.code === 4001 || /user (rejected|denied)|rejected the request|cancel/i.test(String(x.message ?? ''))));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = 20_000;
const MAX_RETRIES = 5;

/** 身份在链上的状态有没有变（避免每次重读都触发重新加载） */
const identitySig = (e: Endpoint) => JSON.stringify([e.holder, e.opened, e.key.version, e.key.usable, e.key.key, e.key.current, e.factory]);

export function MessagesView() {
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const [identity, setIdentity] = useState<Endpoint | null>(null);
  const [picking, setPicking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [issues, setIssues] = useState({ dropped: 0, unavailable: 0 });
  // 陌生发件人的消息折叠了多少条；点"全部显示"后不再限量
  const [folded, setFolded] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;
  const [more, setMore] = useState<{ in: MoreToken | null; out: MoreToken | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retries, setRetries] = useState(0);
  const [extraPages, setExtraPages] = useState(false);
  const [mutedOpen, setMutedOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [thread, setThread] = useState<Hex | null>(null);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [composing, setComposing] = useState<{ to?: string; ref?: Hex; subject?: string } | null>(null);
  const [keyState, setKeyState] = useState<KeyState>('idle');
  const [keyMenu, setKeyMenu] = useState<null | 'menu' | 'rotate' | 'revoke'>(null);
  const [notice, setNotice] = useState('');
  const [keyTick, setKeyTick] = useState(0);
  const [muteTick, setMuteTick] = useState(0);

  const wagmiConfig = useConfig();
  const { sendTransactionAsync } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: bsc.id });

  // 最新的钱包地址：签名、发交易之前都要核对它没有在中途换掉
  const addressRef = useRef(address);
  addressRef.current = address;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  // 换钱包或断开：身份和内存里的钥匙全部作废
  useEffect(() => {
    clearKeys();
    setIdentity(null);
    setMessages([]);
    setThread(null);
    setComposing(null);
    setKeyState('idle');
    setKeyMenu(null);
    setError('');
    setNotice('');
  }, [address]);

  /** 重读自己的端点：持有人不再是本钱包或容器没开通就退出这个身份 */
  const refreshIdentity = useCallback(async (): Promise<Endpoint | null> => {
    const cur = identityRef.current;
    if (!cur) return null;
    const r = await resolveEndpoint(cur.label);
    if (identityRef.current?.container !== cur.container) return null;
    if (!r.endpoint || r.endpoint.holder?.toLowerCase() !== addressRef.current?.toLowerCase() || !r.endpoint.opened) {
      setIdentity(null);
      setError(t('identityLost'));
      return null;
    }
    if (identitySig(r.endpoint) !== identitySig(cur)) setIdentity(r.endpoint);
    return r.endpoint;
  }, []);

  const loadSeq = useRef(0);
  const load = useCallback(async (retry = false) => {
    const cur = identityRef.current;
    if (!cur) return;
    const n = ++loadSeq.current;
    setLoading(true);
    setError('');
    if (!retry) setRetries(0);
    // 每次重新加载都作废旧的续取令牌：切换信箱或身份后，不能拿上一个信箱的候选去续取
    setMore(null);
    setExtraPages(false);
    try {
      // 每次加载都顺带刷新自己的状态：工厂封印、电路合约、钥匙版本（TAP-10 §3.5、§8.7）
      void refreshIdentity().catch(() => {});
      // 会话要同时看收件和发件两个信箱
      const muted = mutedSenders(cur.container);
      const known = contacts(cur.container);
      const [inPage, outPage] = await Promise.all([listMessages(cur, 'in', { muted, contacts: known, showAll: showAllRef.current }), listMessages(cur, 'out', { muted })]);
      if (n !== loadSeq.current) return;
      // 自己发过信的人都是联系人（换设备后从发件目录补回来）
      addContacts(cur.container, outPage.items.map((m) => m.to));
      setFolded(inPage.folded ?? 0);
      setMessages(mergeMessages([...inPage.items, ...outPage.items]));
      setMore(inPage.more || outPage.more ? { in: inPage.more, out: outPage.more } : null);
      setIssues({ dropped: inPage.dropped + outPage.dropped, unavailable: inPage.unavailable + outPage.unavailable });
    } catch (e) {
      if (n === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === loadSeq.current) setLoading(false);
    }
  }, [refreshIdentity]);

  useEffect(() => {
    setMessages([]);
    void load();
  }, [load, identity?.container]);

  const loadMore = useCallback(async () => {
    const cur = identityRef.current;
    if (!cur || !more) return;
    const n = loadSeq.current;
    setLoadingMore(true);
    try {
      const muted = mutedSenders(cur.container);
      const empty = { items: [] as Message[], dropped: 0, unavailable: 0, folded: 0, more: null as MoreToken | null };
      const [inPage, outPage] = await Promise.all([
        more.in ? listMessages(cur, 'in', { more: more.in, muted, contacts: contacts(cur.container), showAll: showAllRef.current }) : Promise.resolve(empty),
        more.out ? listMessages(cur, 'out', { more: more.out, muted }) : Promise.resolve(empty),
      ]);
      if (n !== loadSeq.current) return;
      setMessages((old) => mergeMessages([...old, ...inPage.items, ...outPage.items]));
      addContacts(cur.container, outPage.items.map((m) => m.to));
      setFolded((f) => f + (inPage.folded ?? 0));
      setMore(inPage.more || outPage.more ? { in: inPage.more, out: outPage.more } : null);
      setExtraPages(true);
      // 更早那几页里暂时核验不了的条目不计入自动重试（自动重试只重载第一页，不能把已加载的页面冲掉）
      setIssues((i) => ({ dropped: i.dropped + inPage.dropped + outPage.dropped, unavailable: i.unavailable }));
    } catch (e) {
      if (n === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [more]);

  // 自动收新消息：页面在前台时每 4 秒看一眼两个信箱的总数（一包两个很轻的链上读取），变了才重新加载；切到后台自动暂停
  const lastCounts = useRef('');
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  useEffect(() => {
    if (!identity) return;
    lastCounts.current = '';
    let alive = true;
    // 总数一直在变（例如有人刷消息，静音的发件人也会让总数变）：重新加载的间隔逐次加倍，最长 60 秒，安静下来再恢复
    let gap = 0;
    let lastReload = 0;
    const tick = async () => {
      if (!alive || document.visibilityState !== 'visible' || loadingRef.current) return;
      const cur = identityRef.current;
      if (!cur) return;
      const c = await boxCounts(cur).catch(() => '');
      if (!alive || !c) return;
      if (lastCounts.current && c !== lastCounts.current) {
        if (Date.now() - lastReload < gap) return; // 先不记新总数：间隔到了再加载
        lastReload = Date.now();
        gap = Math.min(Math.max(gap * 2, 8_000), 60_000);
        void load(true);
      } else if (Date.now() - lastReload > 60_000) {
        gap = 0;
      }
      lastCounts.current = c;
    };
    void tick();
    const timer = setInterval(() => void tick(), 4_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [identity?.container, load]);

  /** 刚发出一条：链上读取有几秒延迟，接连多刷几次，直到列表里出现为止 */
  const refreshAfterSend = useCallback(() => {
    for (const ms of [1500, 5000, 10_000, 20_000]) setTimeout(() => void load(true), ms);
  }, [load]);

  // 有"确认中"或暂时核验不了的消息：过一会儿自动重新核验，间隔逐次加倍，最多 5 次
  useEffect(() => {
    if ((!messages.some((m) => m.pending) && issues.unavailable === 0) || retries >= MAX_RETRIES || extraPages) return;
    const timer = setTimeout(() => {
      setRetries((r) => r + 1);
      void load(true);
    }, RETRY_MS * 2 ** retries);
    return () => clearTimeout(timer);
  }, [messages, issues.unavailable, load, retries, extraPages]);

  // 签名不经过 react-query 的缓存（签名就是钥匙），并指定账户
  const sign = useCallback(
    async (text: string) => {
      const account = addressRef.current as Hex | undefined;
      if (!account) throw new Error(t('accountChanged'));
      return (await signMessage(wagmiConfig, { message: text, account })) as Hex;
    },
    [wagmiConfig],
  );

  /** 发交易前核对：钱包没有中途换掉 */
  const sameWallet = (wallet: string) => addressRef.current?.toLowerCase() === wallet.toLowerCase();

  /** 最近一次发起的"发布公钥"：用来防止重复开启 */
  const pendingPublish = useRef<{ container: string; wallet: string; publicKey: string; at: number } | null>(null);

  /** 每 3 秒重读一次自己的端点，最多 tries 次，直到 done 成立 */
  const pollKey = useCallback(async (done: (e: Endpoint) => boolean, tries: number): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      const e = await refreshIdentity().catch(() => null);
      if (e && done(e)) return true;
      await sleep(3000);
    }
    return false;
  }, [refreshIdentity]);

  /** 等交易结果（替换、取消、回滚都不算成功，多节点核对回执）；再等链上读到新状态（节点的固定区块会落后几块） */
  const waitFor = useCallback(async (hash: Hex, expected: ExpectedLog, done: (e: Endpoint) => boolean): Promise<KeyState> => {
    if (!publicClient) return 'unknown';
    const outcome = await confirmTx((args) => publicClient.waitForTransactionReceipt(args), hash, { ...expected, wallet: addressRef.current });
    if (outcome.status === 'reverted') return 'reverted';
    if (outcome.status === 'replaced') return 'replaced';
    if (outcome.status === 'unknown') return 'unknown';
    setKeyState('confirming');
    for (let i = 0; i < 20; i++) {
      const e = await refreshIdentity().catch(() => null);
      if (e && done(e)) return 'idle';
      await sleep(3000);
    }
    return 'not-visible';
  }, [publicClient, refreshIdentity]);

  const doUnlock = useCallback(async (rotate = false) => {
    if (!identity || !address) return;
    const wallet = address as Hex;
    const blocked = keySigningBlocked(connector?.id);
    if (blocked) {
      setKeyState('blocked');
      return;
    }
    setKeyState('working');
    setError('');
    try {
      // 上一笔发布公钥的交易可能还没上链（或还在钱包里等确认）：先等它，别再签一轮、再发一笔
      const pend = pendingPublish.current;
      if (!rotate && pend && pend.container === identity.container && pend.wallet === wallet.toLowerCase() && Date.now() - pend.at < 15 * 60_000) {
        setKeyState('confirming');
        const ok = await pollKey((e) => e.key.usable && e.key.key.toLowerCase() === pend.publicKey && e.key.current.toLowerCase() === pend.wallet, 10);
        pendingPublish.current = null;
        if (ok && currentKeyUnlocked(wallet, identityRef.current ?? identity)) { setKeyState('idle'); setKeyTick((n) => n + 1); return; }
        setKeyState('working');
      }
      // 用链上最新状态决定：只解锁，还是派生并发布新钥匙（TAP-10 §4.2、§4.5）
      const fresh = await refreshIdentity();
      if (!fresh) { setKeyState('idle'); return; }
      const r = await unlock(fresh, wallet, sign, { rotate });
      if (r.status !== 'unlocked') {
        setKeyState(r.status);
        return;
      }
      if (r.needsPublish) {
        if (!sameWallet(wallet)) { setKeyState('account-changed'); return; }
        setKeyState('publishing');
        const tx = publishKeyTx(fresh, r.keyIndex, r.publicKey);
        const landed = (e: Endpoint) => e.key.usable && e.key.key.toLowerCase() === r.publicKey && e.key.current.toLowerCase() === wallet.toLowerCase();
        pendingPublish.current = { container: fresh.container, wallet: wallet.toLowerCase(), publicKey: r.publicKey, at: Date.now() };
        let hash: Hex;
        try {
          hash = (await sendTransactionAsync({ to: tx.to, data: tx.data, chainId: bsc.id, account: wallet })) as Hex;
        } catch (e) {
          if (isUserRejection(e)) { pendingPublish.current = null; throw e; }
          // 钱包接口报错不等于交易没发：WalletConnect 超时后，钱包里可能还挂着这笔请求、用户稍后仍会确认。
          // 先等链上出现这把钥匙，不让用户重复开启（重复开启会再签两次、再发一笔交易）
          setKeyState('confirming');
          if (await pollKey(landed, 30)) { pendingPublish.current = null; setKeyState('idle'); setKeyTick((n) => n + 1); return; }
          setKeyState('publish-unknown');
          return;
        }
        const result = await waitFor(hash, { topic0: HUB_TOPICS.KeyPublished, container: fresh.container, data: tx.data }, landed);
        if (result !== 'idle') { setKeyState(result); return; }
        pendingPublish.current = null;
      }
      setKeyState('idle');
      setKeyTick((n) => n + 1);
    } catch (e) {
      setKeyState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [identity, address, connector, sign, sendTransactionAsync, refreshIdentity, waitFor, pollKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const doRevoke = useCallback(async () => {
    if (!identity || !address) return;
    const wallet = address as Hex;
    setKeyMenu(null);
    setKeyState('publishing');
    setError('');
    try {
      const fresh = await refreshIdentity();
      if (!fresh) { setKeyState('idle'); return; }
      if (!sameWallet(wallet)) { setKeyState('account-changed'); return; }
      const tx = revokeKeyTx(fresh);
      const hash = await sendTransactionAsync({ to: tx.to, data: tx.data, chainId: bsc.id, account: wallet });
      const result = await waitFor(hash as Hex, { topic0: HUB_TOPICS.KeyRevoked, container: fresh.container, data: tx.data }, (e) => !e.key.usable);
      setKeyState(result);
      if (result === 'idle') {
        clearKeys();
        setNotice(t('keyRevoked'));
      }
      setKeyTick((n) => n + 1);
    } catch (e) {
      setKeyState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [identity, address, sendTransactionAsync, refreshIdentity, waitFor]);

  const keyReady = Boolean(identity && address && identity.key.usable && identity.key.current.toLowerCase() === address.toLowerCase());
  const unlocked = Boolean(identity && address && currentKeyUnlocked(address, identity));
  const halted = identity ? !identity.factory.circuitsIntact : false;

  const muted = useMemo(() => (identity ? mutedSenders(identity.container) : new Set<string>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.container, muteTick]);
  const visible = useMemo(() => messages.filter((m) => m.direction === 'out' || !muted.has(m.from.toLowerCase())), [messages, muted]);

  const conversations = useMemo(() => (identity ? groupConversations(visible, identity) : []), [visible, identity]);
  const threadMessages = useMemo(() => (thread ? conversations.find((c) => c.peer.toLowerCase() === thread.toLowerCase())?.messages ?? [] : []), [conversations, thread]);

  // 只解密看得到的消息：静音发件人的内容不打开（TAP-10 §8.4）
  const opened = useMemo(
    () => new Map(visible.map((m) => [m.id, identity && address ? openMessage(m, address, identity.container) : { status: 'locked' as const }])),
    // keyTick：解锁或换钥匙后重新解密
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, identity?.container, address, keyTick],
  );

  if (!isConnected || !address) {
    return (
      <div className="scroll">
        <div className="empty">
          <h2>{t('connectTitle')}</h2>
          <p>{t('connectText')}</p>
          <button className="btn primary" onClick={() => (hasAppKit ? void openWalletModal() : connector === undefined && document.querySelector<HTMLButtonElement>('.wallet-btn')?.click())}>
            {t('connect')}
          </button>
        </div>
      </div>
    );
  }
  if (chainId !== bsc.id) {
    return (
      <div className="scroll"><div className="empty"><p>{t('wrongChain')}</p></div></div>
    );
  }
  if (!identity || picking) {
    return (
      <>
        {error && !identity ? <div className="page" style={{ paddingBottom: 0 }}><div className="notice bad" role="alert">{error}</div></div> : null}
        <IdentityPicker
          wallet={address as Hex}
          onCancel={identity ? () => setPicking(false) : undefined}
          onPick={(ep) => {
            setError('');
            // 换了身份：关掉旧身份打开的会话和写信框，不能用新身份继续旧会话
            setThread(null);
            setComposing(null);
            setAssetsOpen(false);
            setIdentity(ep);
            setPicking(false);
          }}
        />
      </>
    );
  }

  const keyBusy = keyState === 'working' || keyState === 'publishing' || keyState === 'confirming';
  const keyProblem = {
    nondeterministic: t('nondeterministic'),
    mismatch: t('keyMismatch'),
    blocked: t('embeddedWalletBlocked'),
    'account-changed': t('accountChanged'),
    reverted: t('txReverted'),
    replaced: t('txReplaced'),
    unknown: t('txUnknown'),
    'not-visible': t('txNotVisible'),
    'publish-unknown': t('publishUnknown'),
  }[keyState as string];
  // 钥匙对不上（或确认失败）时也要能进"钥匙管理"：重新发布或撤销，否则用户被卡死
  const showKeyMenu = !halted && ((keyReady && unlocked) || keyState === 'mismatch' || (keyReady && !keyBusy && keyState !== 'idle'));

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div className="scroll">
        <div className="list-head">
          <h1 className="list-title">{t('chats')}</h1>
          <button className="identity" onClick={() => setPicking(true)} title={identity.container}>
            <b className="mono">{identity.label}</b>
          </button>
          <button className="icon-btn" onClick={() => void load()} disabled={loading} aria-label={t('reload')} title={t('reload')}>{loading ? <span className="spinner" /> : <IconReload />}</button>
          <button className="btn small" onClick={() => setAssetsOpen(true)}>{t('assets')}</button>
          {showKeyMenu ? (
            <button className="btn small" disabled={keyBusy} onClick={() => setKeyMenu('menu')}>{t('keyManage')}</button>
          ) : null}
        </div>

        <div className="page" style={{ paddingTop: 8, paddingBottom: 0 }}>
          {halted ? <div className="notice bad" role="alert" style={{ marginBottom: 8 }}>{t('circuitsChanged')}</div> : null}
          {!halted && !keyReady ? (
            <section className="setup-card">
              <div className="setup-icon"><IconLock /></div>
              <h2>{t('unlockTitle')}</h2>
              <p>{t('unlockText')}</p>
              <p className="hint">{t('publishKeyNeeded')}</p>
              {keyProblem ? <p className="hint bad">{keyProblem}</p> : null}
              {keyState === 'confirming' ? <p className="hint">{t('confirmingOnChain')}</p> : null}
              <button className="btn primary setup-btn" disabled={keyBusy} onClick={() => void doUnlock(false)}>
                {keyBusy ? <span className="spinner" /> : t('unlock')}
              </button>
            </section>
          ) : null}
          {!halted && keyReady && !unlocked ? (
            <div className="notice unlock-row" style={{ marginBottom: 8 }}>
              <IconLock />
              <div className="grow">
                <div>{t('locked')}</div>
                {keyProblem ? <div className="hint bad">{keyProblem}</div> : null}
              </div>
              <button className="btn small primary" disabled={keyBusy} onClick={() => void doUnlock(false)}>
                {keyBusy ? <span className="spinner" /> : t('unlockOnly')}
              </button>
            </div>
          ) : null}
          {keyReady && unlocked && keyProblem ? <div className="notice bad" style={{ marginBottom: 8 }}>{keyProblem}</div> : null}
          {notice ? <div className="notice ok" style={{ marginBottom: 8 }}>{notice}</div> : null}
          {folded > 0 && !showAll ? (
            <div className="notice warn" style={{ marginBottom: 8 }}>
              <span className="grow">{t('foldedStrangers').replace(/\{n\}/g, () => String(folded))}</span>
              <button className="btn small" onClick={() => { setShowAll(true); showAllRef.current = true; void load(); }}>{t('foldedShowAll')}</button>
            </div>
          ) : null}
          {issues.dropped > 0 ? <div className="notice bad" style={{ marginBottom: 8 }}>{t('droppedItems').replace('{n}', String(issues.dropped))}</div> : null}
          {issues.unavailable > 0 ? <div className="notice warn" style={{ marginBottom: 8 }}>{t('unavailableItems').replace('{n}', String(issues.unavailable))}</div> : null}
          {error ? <div className="notice bad" role="alert">{error}</div> : null}
          {issues.unavailable > 0 && (retries >= MAX_RETRIES || extraPages) ? <button className="btn small" onClick={() => void load()}>{t('retryNow')}</button> : null}
          {muted.size > 0 ? (
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => setMutedOpen(true)}>{t('mutedManage').replace('{n}', String(muted.size))}</button>
          ) : null}
        </div>

        {halted || keyReady ? (
          <ConversationList
            conversations={conversations}
            me={identity}
            opened={opened}
            loading={loading}
            isNew={(peer) => { const c = endpointContainer(peer); return Boolean(c && c !== identity.container.toLowerCase() && !knownPeer(identity.container, c)); }}
            onOpen={setThread}
          />
        ) : null}
        {more && !loading ? (
          <div className="page" style={{ textAlign: 'center' }}>
            <button className="btn" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <span className="spinner" /> : t('loadMore')}</button>
          </div>
        ) : null}
      </div>

      {!halted ? (
        <button className="fab" onClick={() => setComposing({})}>
          <IconPen />
          {t('compose')}
        </button>
      ) : null}

      {thread ? (
        <ChatThread
          me={identity}
          wallet={address as Hex}
          peer={thread}
          messages={threadMessages}
          opened={opened}
          halted={halted}
          muted={Boolean(endpointContainer(thread) && muted.has(endpointContainer(thread)!))}
          isNew={(() => { const c = endpointContainer(thread); return Boolean(c && c !== identity.container.toLowerCase() && !knownPeer(identity.container, c)); })()}
          onClose={() => setThread(null)}
          onMute={(m) => {
            const c = endpointContainer(thread);
            if (!c) return;
            setMuted(identity.container, c, m);
            setMuteTick((x) => x + 1);
            if (m) setThread(null);
          }}
          onIdentity={(e) => setIdentity(e)}
          onSent={(warning) => {
            if (warning) setNotice(warning);
            refreshAfterSend();
          }}
          onRefresh={() => void load()}
          refreshing={loading}
        />
      ) : null}

      {assetsOpen ? (
        <AssetsSheet
          me={identity}
          wallet={address as Hex}
          received={{ tokens: [], nfts: [] }}
          onClose={() => setAssetsOpen(false)}
        />
      ) : null}

      {composing ? (
        <Compose
          me={identity}
          wallet={address as Hex}
          initial={composing}
          onIdentity={(e) => setIdentity(e)}
          onClose={() => setComposing(null)}
          onSent={(warning) => {
            setComposing(null);
            if (warning) setNotice(warning);
            setNotice((n) => n || t('sentSyncing'));
            refreshAfterSend();
          }}
        />
      ) : null}

      {mutedOpen ? (
        <div className="modal-backdrop" onClick={() => setMutedOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <h3>{t('mutedTitle')}</h3>
            <ul className="row-list">
              {[...muted].map((addr) => (
                <li key={addr} className="row-btn">
                  <span className="grow mono" title={addr}>{addr.slice(0, 10)}…{addr.slice(-8)}</span>
                  <button className="btn small" onClick={() => { setMuted(identity.container, addr, false); setMuteTick((x) => x + 1); }}>{t('unmute')}</button>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button className="btn primary" onClick={() => { setMutedOpen(false); void load(); }}>{t('close')}</button>
            </div>
          </div>
        </div>
      ) : null}

      {keyMenu ? (
        <div className="modal-backdrop" onClick={() => setKeyMenu(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
            {keyMenu === 'menu' ? (
              <>
                <h3>{t('keyManage')}</h3>
                <p className="hint">{t('keyManageText')}</p>
                <div className="actions">
                  <button className="btn" onClick={() => setKeyMenu(null)}>{t('cancel')}</button>
                  <button className="btn" onClick={() => setKeyMenu('revoke')}>{t('revokeKey')}</button>
                  <button className="btn primary" onClick={() => setKeyMenu('rotate')}>{t('rotateKey')}</button>
                </div>
              </>
            ) : keyMenu === 'rotate' ? (
              <>
                <h3>{t('rotateKey')}</h3>
                <p>{t('rotateKeyText')}</p>
                <div className="actions">
                  <button className="btn" onClick={() => setKeyMenu(null)}>{t('cancel')}</button>
                  <button className="btn primary" onClick={() => { setKeyMenu(null); void doUnlock(true); }}>{t('confirm')}</button>
                </div>
              </>
            ) : (
              <>
                <h3>{t('revokeKey')}</h3>
                <p>{t('revokeKeyText')}</p>
                <div className="actions">
                  <button className="btn" onClick={() => setKeyMenu(null)}>{t('cancel')}</button>
                  <button className="btn primary" onClick={() => void doRevoke()}>{t('confirm')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
