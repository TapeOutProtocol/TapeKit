import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi';
import { bsc } from 'wagmi/chains';
import { t } from '../i18n';
import { IconClip, IconClose, IconSend } from '../icons';
import { compressImage } from '../data/image';
import { type AssetKind, type ComposeItem, AssetDialog, AttachmentChips } from './Attachments';
import {
  type AssetDraft, type Attachment, type Endpoint, type Hex, HUB_TOPICS, formatUnits, tokenInfo, noteTransferTime, walletKind, savedTransfers, saveTransfers, transferReplacement, transferTime, transferTx, txNonce, waitTransfer, TapeSendError, canSeal, confirmTx, forgetSend, noteSendNonce, recheckUnknownSends, recordSend, sendLock, setSendLock, unknownSends, payloadLimit, peerChanged, prepareSend, readsChain, rememberPeer, resolveEndpoint,
} from '../data/tapesend';

type Recipient =
  | { state: 'empty' }
  | { state: 'resolving' }
  | { state: 'bad'; message: string }
  | { state: 'ready'; input: string; endpoint: Endpoint; changed: boolean };

export function Compose({ me, wallet, initial, onIdentity, onClose, onSent, variant = 'sheet', quote, onClearQuote }: {
  me: Endpoint;
  wallet: Hex;
  initial: { to?: string; ref?: Hex; subject?: string };
  /** sheet：全屏写信（新会话）；inline：聊天页底部的输入栏，收件人固定 */
  variant?: 'sheet' | 'inline';
  /** 聊天页里点了「引用回复」：输入框上方显示被引用的内容；initial.ref 就是它的消息 ID */
  quote?: { who: string; text: string } | null;
  onClearQuote?: () => void;
  onIdentity: (e: Endpoint) => void;
  onClose: () => void;
  /** warning：发出去了，但有需要告诉用户的情况 */
  onSent: (warning?: string) => void;
}) {
  const [to, setTo] = useState(initial.to ?? '');
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState('');
  const [recipient, setRecipient] = useState<Recipient>({ state: 'empty' });
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [confirmChanged, setConfirmChanged] = useState(false);
  const [sending, setSending] = useState(false);
  // 附件：图片已压好；资产在发送时才转账（先转账、核对上链，再发消息），转出后记下 tx 并存在本机
  const [items, setItems] = useState<ComposeItem[]>([]);
  const [attachMenu, setAttachMenu] = useState(false);
  const [assetKind, setAssetKind] = useState<AssetKind | null>(null);
  const [confirmAssets, setConfirmAssets] = useState(false);
  const [progress, setProgress] = useState('');
  const [imageError, setImageError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  // 交易已发出但结果不明：记在本机（按钱包 + 容器），确认之前不允许再发，避免同一条消息发两次（关掉撰写框重开也一样）。
  // 打开期间每 30 秒重查：多节点确认上链了才自动放行；判断出不会上链时只提示，由用户核对"已发送"后手动放行
  const [unknownTx, setUnknownTx] = useState<Hex | null>(() => unknownSends(me.container, wallet).at(-1)?.hash ?? null);
  const [resolvedNote, setResolvedNote] = useState('');
  // 上一次结果不明的发送，后来查明是在链上执行失败了：红色提示并附上交易链接
  const [revertedTx, setRevertedTx] = useState<Hex | null>(null);
  const [goneNote, setGoneNote] = useState(false);
  // 钱包那边出错（不是用户拒绝）：交易可能已经广播，先锁住，用户核对后才能再发
  const [walletError, setWalletError] = useState(() => sendLock(me.container, wallet) !== null);
  useEffect(() => {
    if (!unknownTx) return;
    let alive = true;
    const check = async () => {
      const r = await recheckUnknownSends(me.container, wallet).catch(() => null);
      if (!alive || !r) return;
      // 结果不明的消息后来确认上链了：它带的已转出资产已经送达，清掉本机记录，下一条不再强制带上
      for (const c of r.landedTo) saveTransfers(me.container, c, []);
      if (r.landed.length) setResolvedNote(t('unknownLanded'));
      else if (r.reverted.length) { setResolvedNote(''); setRevertedTx(r.reverted[r.reverted.length - 1] ?? null); }
      setGoneNote(r.gone.length > 0);
      // 只有确认上链或回滚的那笔才解锁：本机存储写不进去时，内存里的记录不能被空列表冲掉
      setUnknownTx((prev) => {
        const next = r.left.at(-1)?.hash;
        if (next) return next;
        const decided = new Set([...r.landed, ...r.reverted].map((h) => h.toLowerCase()));
        return prev && !decided.has(prev.toLowerCase()) ? prev : null;
      });
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [me.container, wallet, unknownTx]);
  const { sendTransactionAsync } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: bsc.id });
  const { address } = useAccount();
  const addressRef = useRef(address);
  addressRef.current = address;
  const seq = useRef(0);

  // 输入停顿 400ms 后解析收件人
  useEffect(() => {
    const raw = to.trim();
    if (!raw) {
      setRecipient({ state: 'empty' });
      return;
    }
    const n = ++seq.current;
    setRecipient({ state: 'resolving' });
    const timer = setTimeout(() => {
      resolveEndpoint(raw)
        .then((r) => {
          if (n !== seq.current) return;
          if (!r.endpoint) setRecipient({ state: 'bad', message: t('recipientBad') });
          else setRecipient({ state: 'ready', input: raw, endpoint: r.endpoint, changed: peerChanged(me.container, r.endpoint) });
        })
        .catch((e: unknown) => n === seq.current && setRecipient({ state: 'bad', message: e instanceof Error ? e.message : String(e) }));
    }, 400);
    return () => clearTimeout(timer);
  }, [to, me.container]);

  // 收件人确定后，找回上次已经转出、但消息没发出去的资产：必须随这条消息一起发出，不能重复转账
  const recipientContainer = recipient.state === 'ready' ? recipient.endpoint.container : null;
  // 收件人改了：已经转给原收件人的资产从当前列表拿走（本机记录还在，下次给原收件人写信时自动带上），不能随消息发给别人
  useEffect(() => {
    setItems((cur) => {
      const keep = cur.filter((x) => !(x.kind === 'asset' && x.tx && x.toContainer && x.toContainer !== recipientContainer?.toLowerCase()));
      return keep.length === cur.length ? cur : keep;
    });
  }, [recipientContainer]);
  useEffect(() => {
    if (!recipientContainer) return;
    const saved = savedTransfers(me.container, recipientContainer);
    if (!saved.length) return;
    setItems((cur) => {
      const have = new Set(cur.flatMap((x) => (x.kind === 'asset' && x.tx ? [x.tx] : [])));
      const add: ComposeItem[] = saved.filter((a) => a.type !== 'image' && !have.has(a.tx)).map((a) => {
        const x = a as Exclude<Attachment, { type: 'image' }>;
        const draft = x.type === 'native' ? { type: 'native' as const, amount: x.amount } : x.type === 'erc20' ? { type: 'erc20' as const, token: x.token, amount: x.amount } : { type: 'erc721' as const, token: x.token, tokenId: x.tokenId };
        const label = x.type === 'erc721' ? `NFT #${x.tokenId}` : x.type === 'native' ? `${formatUnits(x.amount, 18)} BNB` : t('attachToken');
        return { id: x.tx, kind: 'asset', draft, label, tx: x.tx, toContainer: recipientContainer.toLowerCase() };
      });
      return add.length ? [...cur, ...add] : cur;
    });
    // 代币要读出小数位和符号，才能写成"0.1 USDT"
    for (const a of saved) {
      if (a.type !== 'erc20' && a.type !== 'erc721') continue;
      void tokenInfo(a.type, a.token).then((info) => {
        if (!info) return;
        const label = a.type === 'erc20' ? `${formatUnits(a.amount, info.decimals)} ${info.symbol}` : `${info.symbol || 'NFT'} #${a.tokenId}`;
        setItems((cur) => cur.map((x) => (x.kind === 'asset' && x.tx === a.tx ? { ...x, label } : x)));
      });
    }
  }, [me.container, recipientContainer]);
  const carried = items.filter((x): x is Extract<ComposeItem, { kind: 'asset' }> => x.kind === 'asset' && Boolean(x.tx));
  // 已转出的资产放了多久：超过 1 小时才随消息发出，对方会看到"转账比消息早了一个多小时"、核实不了。每 30 秒刷新一次
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!carried.length) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [carried.length]);
  const oldestCarried = carried.reduce<number | null>((m, x) => {
    const at = x.tx ? transferTime(x.tx) : null;
    return at !== null && (m === null || at < m) ? at : m;
  }, null);
  // 本钱包是合约钱包（Safe、智能账户）时，附带资产对方核实不了：加资产之前先提示
  const [contractWallet, setContractWallet] = useState(false);
  const hasNewAsset = items.some((x) => x.kind === 'asset' && !x.tx);
  useEffect(() => {
    if (!hasNewAsset) return;
    let alive = true;
    void walletKind(wallet).then((k) => alive && setContractWallet(k === 'contract'));
    return () => { alive = false; };
  }, [wallet, hasNewAsset]);
  const carriedMinutes = oldestCarried !== null ? Math.floor((nowMs - oldestCarried) / 60_000) : null;
  const [dupAsset, setDupAsset] = useState<{ draft: AssetDraft; label: string } | null>(null);

  const wireAttachments = (list: ComposeItem[]): Attachment[] => list.map((it) => (it.kind === 'image'
    ? { type: 'image', mime: it.att.mime, data: it.att.data, w: it.att.w, h: it.att.h }
    : ({ ...it.draft, chainId: 56, tx: it.tx ?? (('0x' + '0'.repeat(64)) as Hex) } as Attachment)));
  const bytes = useMemo(() => new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'message', subject, body, attachments: wireAttachments(items), ts: Date.now() })).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, body, items]);
  const tooLarge = bytes > payloadLimit - 93 - 112 - 16;
  const subjectTooLong = [...subject].length > 200;

  const hint = (() => {
    switch (recipient.state) {
      case 'resolving':
        return <span className="hint">{t('resolving')}</span>;
      case 'bad':
        return <span className="hint bad">{recipient.message}</span>;
      case 'ready': {
        const ep = recipient.endpoint;
        if (recipient.changed) return <span className="hint bad">{t('recipientKeyChanged')}</span>;
        if (canSeal(ep)) return <span className="hint ok">{ep.label} {t('recipientOk')}</span>;
        if (ep.key.usable) return <span className="hint warn">{ep.label} {t('recipientBadKey')}</span>;
        return <span className="hint warn">{ep.label} {ep.opened ? t('recipientNoKey') : t('recipientUnopened')}</span>;
      }
      default:
        return null;
    }
  })();

  const send = async (publicOk: boolean) => {
    if (recipient.state !== 'ready') return;
    const snapshot = recipient;
    setSending(true);
    setError('');
    let walletCalled = false;
    const stop = (message: string) => {
      setError(message);
      setSending(false);
    };
    try {
      // TAP-10 §9 第 2、5 步：签名前重新读自己和收件人（同一轮严格一致读取），任何变化都停下重新确认
      const [freshMe, fresh] = await Promise.all([resolveEndpoint(me.label), resolveEndpoint(snapshot.endpoint.container)]);
      if (!freshMe.endpoint || freshMe.endpoint.holder?.toLowerCase() !== wallet.toLowerCase() || !freshMe.endpoint.opened) return stop(t('identityLost'));
      onIdentity(freshMe.endpoint);
      if (!freshMe.endpoint.factory.circuitsIntact) return stop(t('circuitsChanged'));
      // 消息合约的实现被换成了客户端没核对过的版本：可能改了身份核对或公钥记录，不发
      if (!freshMe.endpoint.hub.expectedImplementation) return stop(t('hubChanged'));
      if (
        !fresh.endpoint || fresh.endpoint.container !== snapshot.endpoint.container
        || fresh.endpoint.key.version !== snapshot.endpoint.key.version || fresh.endpoint.key.usable !== snapshot.endpoint.key.usable
        || fresh.endpoint.holder !== snapshot.endpoint.holder
      ) {
        setRecipient(fresh.endpoint ? { state: 'ready', input: snapshot.input, endpoint: fresh.endpoint, changed: true } : { state: 'bad', message: t('recipientBad') });
        setSending(false);
        return;
      }
      if (canSeal(fresh.endpoint) === publicOk) return stop(t('recipientChangedRetry'));
      // 对方公钥可用、但收信链位图里没有本链那一位：发出去对方不会读（按原始位图判断）
      if (fresh.endpoint.key.usable && !readsChain(fresh.endpoint, freshMe.endpoint.chainId)) return stop(t('recipientNoHomeChain'));
      // 钱包中途换了：不发
      if (addressRef.current?.toLowerCase() !== wallet.toLowerCase()) return stop(t('accountChanged'));
      // 别的标签页刚发出一条结果不明的、或正在钱包里等确认的：也不发
      const pendingNow = unknownSends(me.container, wallet).at(-1);
      if (pendingNow) { setUnknownTx(pendingNow.hash); return stop(t('txUnknown')); }
      if (sendLock(me.container, wallet)) { setWalletError(true); return stop(t('walletErrorCheckSent')); }
      // 资产附件：逐个从本钱包转进对方的电路容器。
      // 钱包一返回交易编号就立刻记在本机、标成"已转出"：之后无论超时、钱包加速替换、页面刷新，都不会再转第二次。
      // 只有链上明确判定交易失败（资产没转出）时，才撤销这条记录、允许重新转。
      // 已经转给别的容器的资产不随这条消息发（收件人中途改过）
      let current = items.filter((x) => !(x.kind === 'asset' && x.tx && x.toContainer && x.toContainer !== fresh.endpoint.container.toLowerCase()));
      const saveCurrent = () => saveTransfers(me.container, fresh.endpoint.container, wireAttachments(current.filter((x) => x.kind === 'asset' && x.tx)));
      for (const it of current) {
        if (it.kind !== 'asset' || it.tx) continue;
        setProgress(t('attachTransferring').replace(/\{what\}/g, () => it.label));
        const tx = transferTx(it.draft, wallet, fresh.endpoint.container);
        // 转账也要上发送锁：两个标签页不能同时转；钱包报错（不是拒绝）时锁住，等用户核对
        setSendLock(me.container, wallet, 'sending');
        walletCalled = true;
        const hash = (await sendTransactionAsync({ to: tx.to, data: tx.data, value: tx.value, chainId: bsc.id, account: wallet })) as Hex;
        walletCalled = false;
        noteTransferTime(hash);
        current = current.map((x) => (x.id === it.id ? { ...x, tx: hash, toContainer: fresh.endpoint.container.toLowerCase() } : x));
        setItems(current);
        // 已转出记录写不进本机存储：不解锁（刷新页面后才不会重新转一次），提示用户
        if (!saveCurrent()) { setProgress(''); setWalletError(true); return stop(`${t('attachSaveFailed')} ${hash}`); }
        setSendLock(me.container, wallet, null);
        // 同时让钱包连接库盯着这笔交易：钱包里"加速"或"取消"时它会报告替换交易
        const nonce = await txNonce(hash, wallet);
        let replacedBy: Hex | null = null;
        const watching = publicClient
          ? publicClient.waitForTransactionReceipt({ hash, timeout: 200_000, onReplaced: (x) => { replacedBy = x.transaction.hash as Hex; } }).catch(() => null)
          : Promise.resolve(null);
        let r = await waitTransfer(hash, it.draft, fresh.endpoint.container);
        if (r === 'unknown') {
          await watching;
          const rep = replacedBy as Hex | null;
          const kind = rep ? await transferReplacement(hash, rep, { wallet, nonce, to: tx.to, data: tx.data, value: tx.value }) : 'unknown';
          if (kind === 'same' && rep) {
            // 加速：记录改成替换交易，再按它核对
            noteTransferTime(rep);
            current = current.map((x) => (x.id === it.id ? { ...x, tx: rep } : x));
            setItems(current);
            saveCurrent();
            r = await waitTransfer(rep, it.draft, fresh.endpoint.container);
          } else if (kind === 'cancelled') {
            // 取消：资产没有转出，撤销"已转出"记录
            current = current.map((x) => (x.id === it.id ? { ...x, tx: undefined, toContainer: undefined } : x));
            setItems(current);
            saveCurrent();
            setProgress('');
            return stop(t('attachTransferCancelled'));
          }
        }
        if (r === 'reverted') {
          current = current.map((x) => (x.id === it.id ? { ...x, tx: undefined } : x));
          setItems(current);
          saveCurrent();
          setProgress('');
          return stop(t('attachTransferFailed'));
        }
        if (r === 'mismatch') { setProgress(''); return stop(`${t('attachTransferMismatch')} ${hash}`); }
        if (r === 'unknown') { setProgress(''); return stop(`${t('attachTransferUnknown')} ${hash}`); }
      }
      setProgress(items.some((x) => x.kind === 'asset') ? t('attachSendingMessage') : '');
      const prepared = prepareSend({ me: freshMe.endpoint, wallet, to: fresh.endpoint, subject, body, publicOk, ref: initial.ref, attachments: wireAttachments(current) });
      // 调起钱包之前先上锁：两个标签页不会同时弹出两次确认
      setSendLock(me.container, wallet, 'sending');
      walletCalled = true;
      const hash = (await sendTransactionAsync({ to: prepared.tx.to, data: prepared.tx.data, chainId: bsc.id, account: wallet })) as Hex;
      // 一拿到哈希就记下：之后页面被刷新、App 被系统杀掉，也不会被当成没发过
      // 记录写不进本机存储时保留发送锁：否则另一个标签页会以为没发过，可能重复发送
      if (recordSend(me.container, wallet, hash, { to: fresh.endpoint.endpoint })) setSendLock(me.container, wallet, null);
      else setSendLock(me.container, wallet, 'wallet-error');
      setUnknownTx(hash);
      const nonce = await noteSendNonce(me.container, wallet, hash);
      if (!publicClient) {
        setUnknownTx(hash);
        return stop(t('txUnknown'));
      }
      const outcome = await confirmTx((args) => publicClient.waitForTransactionReceipt(args), hash, { topic0: HUB_TOPICS.Sent, container: fresh.endpoint.endpoint, from: freshMe.endpoint.container, wallet, nonce, data: prepared.tx.data });
      if (outcome.status !== 'success') {
        if (outcome.status === 'reverted') { forgetSend(me.container, wallet, hash); return stop(t('txReverted')); }
        if (outcome.status === 'replaced') { forgetSend(me.container, wallet, hash); return stop(t('txReplaced')); }
        setUnknownTx(hash);
        return stop(t('txUnknown'));
      }
      forgetSend(me.container, wallet, hash);
      rememberPeer(me.container, fresh.endpoint);
      saveTransfers(me.container, fresh.endpoint.container, []);
      setProgress('');
      // TAP-10 §9 第 7 步：在交易所在区块再看一次对方（持有人、公钥是否可用、版本）；签名到打包之间变了，对方可能读不了这条
      let warning: string | undefined;
      const after = await resolveEndpoint(fresh.endpoint.container, { block: outcome.blockNumber }).catch(() => null);
      if (!after?.endpoint) warning = t('recipientCheckFailed');
      else if (
        after.endpoint.holder !== fresh.endpoint.holder
        || (prepared.sealed && (after.endpoint.key.version !== prepared.recipientVersion || !after.endpoint.key.usable))
      ) warning = t('recipientKeyChangedAfterSend');
      if (variant === 'inline') {
        setBody('');
        setItems([]);
        setSending(false);
      }
      onSent(warning);
    } catch (e) {
      // 只有调起钱包之后的错误才可能"交易已经广播"；用户明确拒绝（错误码 4001 / UserRejectedRequestError）就解锁，其它一律保留锁
      const err = e as { name?: string; code?: number; cause?: { code?: number; name?: string } } | null;
      const rejected = Boolean(err && (err.code === 4001 || err.cause?.code === 4001 || err.name === 'UserRejectedRequestError' || err.cause?.name === 'UserRejectedRequestError'));
      const walletSide = walletCalled && !rejected && !(e instanceof TapeSendError);
      if (walletCalled && rejected) setSendLock(me.container, wallet, null);
      if (walletSide) {
        setSendLock(me.container, wallet, 'wallet-error');
        setWalletError(true);
      }
      setProgress('');
      // 在钱包里点了拒绝（或钱包自己拒收）：不是错误，给一句能看懂的话；带图片的大消息另外提示
      if (rejected) {
        const big = bytes > 4000;
        stop(big ? t('walletRejectedBig') : t('walletRejected'));
        return;
      }
      stop(e instanceof TapeSendError && e.code === 'too-large' ? t('tooLarge') : walletSide ? `${t('walletErrorCheckSent')} (${e instanceof Error ? e.message : String(e)})` : e instanceof Error ? e.message : String(e));
    }
  };

  const ready = recipient.state === 'ready';
  // 已经点了发送：输入框全部锁住，界面上看到的收件人就是交易里的收件人
  const stale = ready && recipient.input !== to.trim();
  const sealedPossible = ready && canSeal(recipient.endpoint);
  const halted = !me.factory.circuitsIntact;
  const canSend = ready && !stale && !halted && !unknownTx && !walletError && (body.trim().length > 0 || items.length > 0) && !tooLarge && !subjectTooLong && !sending;
  const pendingAssets = items.filter((x): x is Extract<ComposeItem, { kind: 'asset' }> => x.kind === 'asset' && !x.tx);

  const pickImage = async (file: File | undefined) => {
    setImageError('');
    if (!file) return;
    if (items.length >= 4) { setImageError(t('attachTooMany')); return; }
    try {
      const att = await compressImage(file);
      setItems((cur) => [...cur, { id: `img-${Date.now()}-${Math.random()}`, kind: 'image', att }]);
    } catch (e) {
      setImageError(e instanceof TapeSendError && e.code === 'too-large' ? t('attachImageTooLarge') : t('attachImageBad'));
    }
  };
  const attachButton = (
    <div className="menu-anchor">
      <button type="button" className="icon-btn attach-btn" disabled={sending || halted || items.length >= 4} onClick={() => setAttachMenu((v) => !v)} aria-label={t('attach')} aria-expanded={attachMenu}><IconClip /></button>
      {attachMenu ? (
        <>
          <div className="menu-backdrop" onClick={() => setAttachMenu(false)} />
          <div className={`menu ${variant === 'inline' ? 'menu-up' : ''}`} role="menu">
            <button role="menuitem" onClick={() => { setAttachMenu(false); fileRef.current?.click(); }}>{t('attachImage')}<span className="menu-hint">{t('attachImageHint')}</span></button>
            <button role="menuitem" onClick={() => { setAttachMenu(false); setAssetKind('erc20'); }}>{t('attachToken')}<span className="menu-hint">{t('attachAssetHint')}</span></button>
            <button role="menuitem" onClick={() => { setAttachMenu(false); setAssetKind('erc721'); }}>{t('attachNft')}<span className="menu-hint">{t('attachAssetHint')}</span></button>
            <button role="menuitem" onClick={() => { setAttachMenu(false); setAssetKind('bem'); }}>BEM<span className="menu-hint">{t('attachAssetHint')}</span></button>
          </div>
        </>
      ) : null}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
  const attachUi = (
    <>
      {carried.length ? <div className="notice warn" style={{ margin: '4px 0' }}>{t('attachCarried').replace(/\{what\}/g, () => carried.map((x) => x.label).join('、'))}</div> : null}
      {contractWallet && hasNewAsset ? <div className="notice warn" role="alert" style={{ margin: '4px 0' }}>{t('attachContractWallet')}</div> : null}
      {carriedMinutes !== null && carriedMinutes >= 40 ? (
        <div className="notice bad" role="alert" style={{ margin: '4px 0' }}>
          {(carriedMinutes >= 60 ? t('attachCarriedLate') : t('attachCarriedSoon')).replace(/\{n\}/g, () => String(carriedMinutes))}
        </div>
      ) : null}
      <AttachmentChips items={items} disabled={sending} onRemove={(id) => setItems((cur) => cur.filter((x) => x.id !== id))} />
      {imageError ? <div className="hint bad">{imageError}</div> : null}
      {progress ? <div className="hint">{progress}</div> : null}
    </>
  );

  const trySend = () => {
    if (recipient.state !== 'ready') return;
    if (recipient.changed && !confirmChanged) {
      setConfirmChanged(true);
      return;
    }
    if (!sealedPossible) {
      setConfirmPublic(true);
      return;
    }
    if (pendingAssets.length && !confirmAssets) {
      setConfirmAssets(true);
      return;
    }
    setConfirmAssets(false);
    void send(false);
  };

  const modals = (
    <>
      {assetKind ? (
        <AssetDialog
          kind={assetKind}
          wallet={wallet}
          recipient={recipient.state === 'ready' ? recipient.endpoint : null}
          onClose={() => setAssetKind(null)}
          onAdd={(draft, label) => {
            setAssetKind(null);
            // 已经有一笔同一种资产转出了、还没随消息发出：先提醒，免得以为上次失败又转一次
            const same = carried.some((x) => x.draft.type === draft.type && ('token' in x.draft ? x.draft.token : '') === ('token' in draft ? draft.token : ''));
            if (same) { setDupAsset({ draft, label }); return; }
            setItems((cur) => [...cur, { id: `asset-${Date.now()}-${Math.random()}`, kind: 'asset', draft, label }]);
          }}
        />
      ) : null}
      {dupAsset ? (
        <div className="modal-backdrop" onClick={() => setDupAsset(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <h3>{t('attachDupTitle')}</h3>
            <p>{t('attachDupText').replace(/\{what\}/g, () => carried.map((x) => x.label).join('、')).replace(/\{new\}/g, () => dupAsset.label)}</p>
            <div className="actions">
              <button className="btn primary" onClick={() => setDupAsset(null)}>{t('attachDupSkip')}</button>
              <button className="btn" onClick={() => { const d = dupAsset; setDupAsset(null); setItems((cur) => [...cur, { id: `asset-${Date.now()}-${Math.random()}`, kind: 'asset', draft: d.draft, label: d.label }]); }}>{t('attachDupAdd')}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmAssets && recipient.state === 'ready' ? (
        <div className="modal-backdrop" onClick={() => setConfirmAssets(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <h3>{t('attachConfirmTitle')}</h3>
            <p>{t('attachConfirmText').replace('{who}', recipient.endpoint.label)}</p>
            <ul className="attach-confirm-list">
              {pendingAssets.map((x) => <li key={x.id}><b>{x.label}</b></li>)}
            </ul>
            <p className="hint mono">{t('attachConfirmTo')} {recipient.endpoint.container}</p>
            {!recipient.endpoint.opened ? <div className="notice warn">{t('attachRecipientUnopened')}</div> : null}
            <p className="hint">{t('attachConfirmSteps').replace('{n}', String(pendingAssets.length + 1))}</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmAssets(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => { setConfirmAssets(false); if (!sealedPossible) void send(true); else void send(false); }}>{t('attachConfirmGo')}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmChanged && recipient.state === 'ready' ? (
        <div className="modal-backdrop" onClick={() => setConfirmChanged(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <h3>{recipient.endpoint.label}</h3>
            <p>{t('recipientKeyChanged')}</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmChanged(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => { setRecipient({ ...recipient, changed: false }); setConfirmChanged(false); }}>{t('confirm')}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmPublic ? (
        <div className="modal-backdrop" onClick={() => setConfirmPublic(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
            <h3>{t('publicWarnTitle')}</h3>
            <p>{t('publicWarnText')}</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmPublic(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => { setConfirmPublic(false); if (pendingAssets.length) setConfirmAssets(true); else void send(true); }}>{t('sendPublic')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  if (variant === 'inline') {
    // 只在有问题时显示收件人状态；正常可加密时不打扰
    const showHint = recipient.state === 'bad' || (recipient.state === 'ready' && (recipient.changed || !canSeal(recipient.endpoint)));
    return (
      <div className="chat-compose">
        {showHint ? <div className="chat-compose-note">{hint}</div> : null}
        {error ? <div className="notice bad chat-compose-note" role="alert">{error}</div> : null}
        {unknownTx && !error ? (
          <div className="notice warn chat-compose-note">
            <div className="grow">
              {goneNote ? t('unknownGone') : t('txUnknown')}{' '}
              <a href={`https://bscscan.com/tx/${unknownTx}`} target="_blank" rel="noopener noreferrer">{t('viewTx')}</a>
            </div>
            <button className="btn small" onClick={() => { if (unknownTx) forgetSend(me.container, wallet, unknownTx); setUnknownTx(unknownSends(me.container, wallet).at(-1)?.hash ?? null); setError(''); }}>{t('unknownRelease')}</button>
          </div>
        ) : null}
        {walletError && !unknownTx ? (
          <div className="notice warn chat-compose-note">
            <div className="grow">{t('walletErrorCheckSent')}</div>
            <button className="btn small" onClick={() => { setSendLock(me.container, wallet, null); setWalletError(false); setError(''); }}>{t('unknownRelease')}</button>
          </div>
        ) : null}
        {resolvedNote && !unknownTx ? <div className="notice ok chat-compose-note">{resolvedNote}</div> : null}
        {revertedTx && !unknownTx ? (
          <div className="notice bad chat-compose-note">
            <div className="grow">{t('prevReverted')} <a href={`https://bscscan.com/tx/${revertedTx}`} target="_blank" rel="noopener noreferrer">{t('viewTx')}</a></div>
            <button className="btn small" onClick={() => setRevertedTx(null)}>{t('close')}</button>
          </div>
        ) : null}
        {tooLarge ? <div className="hint bad chat-compose-note">{t('tooLarge')}</div> : null}
        {quote ? (
          <div className="chat-quote chat-compose-note">
            <div className="grow">
              <span className="tl-quote-who">{t('chatReplyTo').replace('{who}', quote.who)}</span>
              <span className="tl-quote-text">{quote.text}</span>
            </div>
            <button className="icon-btn" onClick={onClearQuote} disabled={sending} aria-label={t('cancel')}><IconClose /></button>
          </div>
        ) : null}
        <div className="chat-compose-note">{attachUi}</div>
        <div className="chat-input-row">
          {attachButton}
          <textarea
            className="chat-input"
            rows={Math.min(5, Math.max(1, body.split('\n').length))}
            value={body}
            disabled={sending || halted}
            placeholder={halted ? t('circuitsChanged') : recipient.state === 'resolving' ? t('resolving') : t('chatPlaceholder')}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // 回车发送、Shift+回车换行；输入法正在拼字时回车只是选字，不发送
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                if (canSend) trySend();
              }
            }}
          />
          <button className="chat-send" disabled={!canSend} onClick={trySend} aria-label={t('send')}>
            {sending ? <span className="spinner" /> : <IconSend />}
          </button>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="sheet" role="dialog" aria-label={t('compose')}>
      <div className="sheet-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('close')} disabled={sending}><IconClose /></button>
        <span className="grow">{t('compose')}</span>
        <button
          className="btn primary small"
          disabled={!canSend}
          onClick={trySend}
        >
          {sending ? t('sending') : sealedPossible || !ready ? t('send') : t('sendPublic')}
        </button>
      </div>
      <div className="scroll">
        <div className="page">
          {halted ? <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>{t('circuitsChanged')}</div> : null}
          <fieldset disabled={sending} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="field">
              <label htmlFor="to">{t('to')}</label>
              <input id="to" className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('toPlaceholder')} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus={!initial.to} />
              {hint}
            </div>
            <div className="field">
              <label htmlFor="subject">{t('subject')}</label>
              <input id="subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('subjectPlaceholder')} maxLength={200} />
              {subjectTooLong ? <span className="hint bad">{t('subjectTooLong')}</span> : null}
            </div>
            <div className="field">
              <label htmlFor="body">{t('body')}</label>
              <textarea id="body" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('bodyPlaceholder')} autoFocus={Boolean(initial.to)} />
              <span className={`hint ${tooLarge ? 'bad' : ''}`}>{bytes.toLocaleString()} / {(payloadLimit - 93 - 112 - 16).toLocaleString()} B</span>
            </div>
            <div className="field">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{attachButton}<span className="hint">{t('attachSheetHint')}</span></div>
              {attachUi}
            </div>
          </fieldset>
          <p className="hint">{t('metadataPublic')}</p>
          {error ? <div className="notice bad" role="alert">{error}</div> : null}
          {unknownTx && !error ? <div className="notice warn">{goneNote ? t('unknownGone') : t('txUnknown')}</div> : null}
          {resolvedNote && !unknownTx ? <div className="notice ok">{resolvedNote}</div> : null}
          {revertedTx && !unknownTx ? <div className="notice bad">{t('prevReverted')} <a href={`https://bscscan.com/tx/${revertedTx}`} target="_blank" rel="noopener noreferrer">{t('viewTx')}</a></div> : null}
          {walletError ? (
            <p className="hint"><button className="btn small" onClick={() => { setSendLock(me.container, wallet, null); setWalletError(false); setError(''); }}>{t('unknownRelease')}</button></p>
          ) : null}
          {unknownTx ? (
            <p className="hint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <a href={`https://bscscan.com/tx/${unknownTx}`} target="_blank" rel="noopener noreferrer">{t('viewTx')}</a>
              <button className="btn small" onClick={() => { if (unknownTx) forgetSend(me.container, wallet, unknownTx); setUnknownTx(unknownSends(me.container, wallet).at(-1)?.hash ?? null); setError(''); }}>{t('unknownRelease')}</button>
            </p>
          ) : null}
        </div>
      </div>

      {modals}
    </div>
  );
}
