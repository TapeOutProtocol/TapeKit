import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { IconClose } from '../icons';
import {
  type AssetDraft, type Attachment, type AttachmentCheck, type Endpoint, type Hex, type Message, type TokenInfo,
  erc20Balance, firstClaim, formatUnits, isCircuitContract, lookalikeToken, nativeBalance, nativeSymbol, nftOwner, onClaims, parseUnits, short, tokenInfo, verifyAttachment,
} from '../data/tapesend';

export type AssetKind = 'native' | 'erc20' | 'erc721' | 'bem';

/** BEM（TapeOut 的代币）合约：BNB Smart Chain 主网 */
export const BEM_TOKEN = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a';

/** 写信框里的一个附件：图片已经压好；资产附件在发送时才转账，转出后记下 tx */
export type ComposeItem =
  | { id: string; kind: 'image'; att: Extract<Attachment, { type: 'image' }> }
  | { id: string; kind: 'asset'; draft: AssetDraft; label: string; tx?: Hex; /** 已转出时转给了哪个容器 */ toContainer?: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** 选代币 / NFT / 原生币：读合约信息、余额或所有权，确认后加进附件（此时还没有转账）。chainId 是发件人那条链：资产在那条链上转 */
export function AssetDialog({ kind: rawKind, wallet, recipient, chainId, onAdd, onClose }: {
  kind: AssetKind; wallet: Hex; recipient: Endpoint | null; chainId: number; onAdd: (draft: AssetDraft, label: string) => void; onClose: () => void;
}) {
  const native = nativeSymbol(chainId);
  // BEM 就是一个固定了合约地址的代币
  const kind: 'native' | 'erc20' | 'erc721' = rawKind === 'bem' ? 'erc20' : rawKind;
  const fixedToken = rawKind === 'bem' ? BEM_TOKEN : null;
  const [token, setToken] = useState(fixedToken ?? '');
  const [amount, setAmount] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [info, setInfo] = useState<TokenInfo | null | 'loading' | 'bad'>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [owner, setOwner] = useState<string | null | 'loading'>(null);
  const [isCircuit, setIsCircuit] = useState<boolean | null>(null);
  useEffect(() => {
    if (kind !== 'erc721' || !ADDRESS.test(token.trim())) { setIsCircuit(null); return; }
    let alive = true;
    void isCircuitContract(token.trim(), chainId).then((v) => alive && setIsCircuit(v));
    return () => { alive = false; };
  }, [kind, token, chainId]);

  useEffect(() => {
    let alive = true;
    if (kind === 'native') {
      setInfo({ symbol: native, name: native, decimals: 18 });
      void nativeBalance(wallet, chainId).then((b) => alive && setBalance(b));
      return () => { alive = false; };
    }
    if (!ADDRESS.test(token.trim())) { setInfo(null); setBalance(null); return; }
    setInfo('loading');
    void tokenInfo(kind, token.trim(), chainId).then((i) => alive && setInfo(i ?? 'bad'));
    if (kind === 'erc20') void erc20Balance(token.trim(), wallet, chainId).then((b) => alive && setBalance(b));
    return () => { alive = false; };
  }, [kind, token, wallet, chainId, native]);

  useEffect(() => {
    if (kind !== 'erc721' || !ADDRESS.test(token.trim()) || !/^\d{1,78}$/.test(tokenId.trim())) { setOwner(null); return; }
    let alive = true;
    setOwner('loading');
    void nftOwner(token.trim(), tokenId.trim(), chainId).then((o) => alive && setOwner(o));
    return () => { alive = false; };
  }, [kind, token, tokenId, chainId]);

  const ti = info && info !== 'loading' && info !== 'bad' ? info : null;
  const units = ti && kind !== 'erc721' ? parseUnits(amount, ti.decimals) : null;
  const enough = units !== null && balance !== null && units <= balance;
  const ownsNft = kind === 'erc721' && typeof owner === 'string' && owner === wallet.toLowerCase();
  const lookalike = ti && kind !== 'native' ? lookalikeToken(ti.symbol, token.trim(), chainId) : false;
  const ok = kind === 'erc721' ? Boolean(ti) && ownsNft && isCircuit === false : Boolean(ti) && units !== null && units > 0n && enough;

  const add = () => {
    if (!ok || !ti) return;
    if (kind === 'native') onAdd({ type: 'native', amount: units!.toString() }, `${amount.trim()} ${native}`);
    else if (kind === 'erc20') onAdd({ type: 'erc20', token: token.trim().toLowerCase() as Hex, amount: units!.toString() }, `${amount.trim()} ${ti.symbol || t('attachToken')}`);
    else onAdd({ type: 'erc721', token: token.trim().toLowerCase() as Hex, tokenId: tokenId.trim() }, `${ti.symbol || 'NFT'} #${tokenId.trim()}`);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <h3>{rawKind === 'bem' ? 'BEM' : kind === 'native' ? native : kind === 'erc20' ? t('attachToken') : t('attachNft')}</h3>
        <p className="hint">{t('attachAssetIntro')}</p>
        {recipient && !recipient.opened ? <div className="notice warn" style={{ marginBottom: 10 }}>{t('attachRecipientUnopened')}</div> : null}
        {kind !== 'native' && !fixedToken ? (
          <div className="field">
            <label htmlFor="asset-token">{kind === 'erc20' ? t('attachTokenAddress') : t('attachNftAddress')}</label>
            <input id="asset-token" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus />
            {info === 'loading' ? <span className="hint">{t('resolving')}</span> : null}
            {info === 'bad' ? <span className="hint bad">{t('attachNotToken')}</span> : null}
            {ti ? <span className="hint">{ti.name || ti.symbol} {ti.symbol ? `(${ti.symbol})` : ''} <span className="mono">{short(token.trim())}</span></span> : null}
            {lookalike ? <span className="hint bad">{t('attachLookalike').replace(/\{symbol\}/g, () => ti!.symbol)}</span> : null}
          </div>
        ) : null}
        {kind === 'erc721' ? (
          <div className="field">
            <label htmlFor="asset-id">{t('attachNftId')}</label>
            <input id="asset-id" className="input mono" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="1234" inputMode="numeric" />
            {owner === 'loading' ? <span className="hint">{t('resolving')}</span> : null}
            {typeof owner === 'string' && !ownsNft ? <span className="hint bad">{t('attachNftNotYours')}</span> : null}
            {ownsNft && isCircuit === false ? <span className="hint ok">{t('attachNftYours')}</span> : null}
            {isCircuit ? <span className="hint bad">{t('attachCircuitNft')}</span> : null}
          </div>
        ) : (
          <div className="field">
            <label htmlFor="asset-amount">{t('attachAmount')}</label>
            <input id="asset-amount" className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" inputMode="decimal" autoFocus={kind === 'native'} />
            {ti && balance !== null ? <span className={`hint ${units !== null && !enough ? 'bad' : ''}`}>{t('attachBalance')}: {formatUnits(balance, ti.decimals)} {ti.symbol}</span> : null}
          </div>
        )}
        <div className="actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" disabled={!ok} onClick={add}>{t('attachAdd')}</button>
        </div>
      </div>
    </div>
  );
}

/** 写信框里已选的附件 */
export function AttachmentChips({ items, disabled, onRemove }: { items: ComposeItem[]; disabled: boolean; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-chips">
      {items.map((it) => (
        <span key={it.id} className="attach-chip">
          {it.kind === 'image'
            ? <img src={`data:${it.att.mime};base64,${it.att.data}`} alt="" />
            : <span className="attach-asset-icon" aria-hidden>◆</span>}
          <span className="attach-chip-text">
            {it.kind === 'image' ? `${t('attachImage')} ${((it.att.size ?? 0) / 1024).toFixed(1)} KB` : it.label}
            {it.kind === 'asset' && it.tx ? <em>{' '}{t('attachTransferred')}</em> : null}
          </span>
          {/* 已经转出的资产不能移除：它必须随下一条消息一起发出，否则对方不知道这笔转账是谁、为什么 */}
          {!(it.kind === 'asset' && it.tx) ? (
            <button className="attach-chip-x" disabled={disabled} onClick={() => onRemove(it.id)} aria-label={t('remove')}><IconClose /></button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function AssetRow({ a, m, repeat }: { a: Exclude<Attachment, { type: 'image' }>; m: Message; repeat: boolean }) {
  const [check, setCheck] = useState<AttachmentCheck | null>(null);
  // 本机"首次引用"记录变了（别的消息核对通过）就重新判断是不是重复引用
  const [, setClaimTick] = useState(0);
  useEffect(() => onClaims(() => setClaimTick((n) => n + 1)), []);
  // 资产在附件声明的那条链上（核对时要求它就是消息所在的链）
  const [info, setInfo] = useState<TokenInfo | null>(a.type === 'native' ? { symbol: nativeSymbol(a.chainId), name: nativeSymbol(a.chainId), decimals: 18 } : null);
  useEffect(() => {
    let alive = true;
    void verifyAttachment(a, m).then((c) => alive && setCheck(c));
    if (a.type !== 'native' && a.chainId === m.chainId) void tokenInfo(a.type, a.token, a.chainId).then((i) => alive && setInfo(i)).catch(() => {});
    return () => { alive = false; };
  }, [a, m]);
  const what = a.type === 'erc721'
    ? `${info?.symbol || 'NFT'} #${a.tokenId}`
    : `${info ? formatUnits(a.amount, info.decimals) : a.amount} ${info?.symbol ?? ''}`;
  const lookalike = a.type !== 'native' && info ? lookalikeToken(info.symbol, a.token, a.chainId) : false;
  const state = !check ? 'checking' : check.status;
  // 同一笔转账已经被更早一条核对通过的消息引用过：这条是重复引用（只在核对通过的消息之间比较，别人抢先引用抢不到）
  const first = state === 'ok' ? firstClaim(a.tx, m.to, m.chainId) : null;
  // 同一条消息里把同一笔转账写了两次：后面那个也算重复
  const duplicate = repeat || Boolean(first && first.id !== m.id);
  // 只有"发件人付的 + 常见代币 + 没有被重复引用 + 不像仿冒"才显示绿色；未知代币即使转账是真的也只显示中性
  const known = check && 'known' in check ? check.known : false;
  const green = state === 'ok' && known && !duplicate && !lookalike;
  const bad = state === 'mismatch' || state === 'not-first' || duplicate || lookalike;
  return (
    <div className={`attach-asset ${green ? 'ok' : bad ? 'bad' : ''}`}>
      <span className="attach-asset-icon" aria-hidden>◆</span>
      <div className="attach-asset-main">
        <b>{what}</b>
        <span className="hint">
          {a.type !== 'native' ? <><span className="mono">{short(a.token)}</span>{' '}</> : null}
          {state === 'checking' ? t('attachChecking')
            : state === 'ok' ? `${t('attachVerified')} ${t('attachFrom')} ${(check as { from: string }).from}`
              : state === 'third-party' ? `${t('attachThirdParty')} ${(check as { from: string }).from}`
              : state === 'late' ? `${t('attachLate')} ${(check as { from: string }).from}`
              : state === 'stale' ? `${t('attachStale')} ${(check as { from: string }).from}`
              : state === 'not-first' ? `${t('attachNotFirst')} ${(check as { from: string }).from}`
              : state === 'crowded' ? `${t('attachCrowded')} ${(check as { from: string }).from}`
              : state === 'unavailable' ? t('attachUnavailable')
                : state === 'other-chain' ? t('chatOtherChain')
                : state === 'pending' ? t('attachPending')
                : state === 'indirect' ? t('attachIndirect')
                : state === 'unverifiable' ? t('attachUnverifiable')
                  : t('attachMismatch')}
        </span>
        {state === 'ok' && !known ? <span className="hint warn">{t('attachUnknownToken')}</span> : null}
        {duplicate ? <span className="hint bad">{t('attachDuplicate')}</span> : null}
        {lookalike ? <span className="hint bad">{t('attachLookalike').replace(/\{symbol\}/g, () => info!.symbol)}</span> : null}
      </div>
    </div>
  );
}

/** 消息卡片里显示附件：图片直接显示（点开看大图），资产附件到链上核对后显示结果 */
export function AttachmentView({ list, m }: { list: Attachment[]; m: Message }) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (!list.length) return null;
  const images = list.filter((a): a is Extract<Attachment, { type: 'image' }> => a.type === 'image');
  const assets = list.filter((a): a is Exclude<Attachment, { type: 'image' }> => a.type !== 'image');
  return (
    <div className="attach-view">
      {images.length ? (
        <div className="attach-images">
          {images.map((img, i) => {
            const src = `data:${img.mime};base64,${img.data}`;
            return <img key={i} src={src} alt="" width={img.w} height={img.h} onClick={(e) => { e.stopPropagation(); setZoom(src); }} />;
          })}
        </div>
      ) : null}
      {assets.map((a, i) => <AssetRow key={i} a={a} m={m} repeat={assets.findIndex((b) => b.tx.toLowerCase() === a.tx.toLowerCase()) < i} />)}
      {zoom ? (
        <div className="modal-backdrop image-zoom" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
        </div>
      ) : null}
    </div>
  );
}
