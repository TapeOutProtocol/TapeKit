import { useCallback, useEffect, useState } from 'react';
import { ChainSwitchError, useChainClient, useChainSend } from '../wallet/tx';
import { t } from '../i18n';
import { IconBack, IconReload } from '../icons';
import { toChecksumAddress } from '../../../../kernel/src/keccak.js';
import {
  type ContainerNft, type ContainerToken, type Endpoint, type Hex, CONTAINER_ERRORS, KNOWN_TOKENS, containerAssets, containerExecFee, formatUnits,
  chainName, explorerUrl, isCircuitContract, isKnownToken, lookalikeToken, nativeSymbol, parseUnits, short, tokenInfo, watchAsset, withdrawTx,
} from '../data/tapesend';

type Pick =
  | { type: 'native'; balance: bigint }
  | { type: 'erc20'; row: ContainerToken }
  | { type: 'erc721'; row: ContainerNft };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// BEM 只在 BNB 上（其他链上这个地址不是 BEM）
const BEM = KNOWN_TOKENS.BEM!;

/** 电路容器资产页：看容器里有什么，并由电路持有人取出（容器的 execute，每次付协议手续费）。都在容器所在的链（me.chainId）上 */
export function AssetsSheet({ me, wallet, received, onClose }: {
  me: Endpoint;
  wallet: Hex;
  /** 收到过的资产附件里出现过的代币和 NFT：自动列进来 */
  received: { tokens: string[]; nfts: Array<{ token: string; tokenId: string }> };
  onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof containerAssets>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [fee, setFee] = useState<bigint | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [adding, setAdding] = useState<null | 'token' | 'nft'>(null);
  const [notice, setNotice] = useState('');
  const isHolder = (me.holder ?? '').toLowerCase() === wallet.toLowerCase();
  const chainId = me.chainId;
  const native = nativeSymbol(chainId);
  const bem = chainId === 56 ? BEM : '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, f] = await Promise.all([containerAssets(me.container, received, chainId), containerExecFee(me.container, chainId)]);
      setData(d);
      setFee(f);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.container, chainId, JSON.stringify(received)]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="sheet assets" role="dialog" aria-label={t('assetsTitle')}>
      <div className="sheet-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('back')}><IconBack /></button>
        <span className="grow">{t('assetsTitle')} <span className="mono">{me.label}</span></span>
        <button className="icon-btn" onClick={() => void load()} disabled={loading} aria-label={t('reload')}><IconReload /></button>
      </div>
      <div className="scroll">
        <div className="page">
          <div className="assets-head">
            <div className="hint">{t('assetsContainer')}</div>
            <div className="mono assets-addr">{me.container}</div>
            <p className="hint">{t('assetsIntro')}</p>
            {!me.opened ? <div className="notice warn">{t('assetsUnopened')}</div> : null}
            {!isHolder ? <div className="notice warn">{t('assetsNotHolder')}</div> : null}
            {fee !== null ? <p className="hint">{t('assetsFee').replace(/\{fee\}/g, () => formatUnits(fee, 18)).replace(/\{symbol\}/g, () => native)}</p> : null}
          </div>
          {notice ? <div className="notice ok" style={{ marginBottom: 8 }}>{notice}</div> : null}

          {!data ? <div className="empty"><span className="spinner" /></div> : (
            <>
              <h3 className="assets-h">{t('assetsCoins')}</h3>
              <ul className="asset-list">
                {data.tokens.filter((r) => r.token === bem).map((r) => (
                  <li key={r.token} className="asset-item">
                    <span className="asset-icon">{(r.info?.symbol || '?').slice(0, 4)}</span>
                    <span className="grow">
                      <b>{r.balance === null || !r.info ? '—' : formatUnits(r.balance, r.info.decimals)} {r.info?.symbol ?? ''}</b>
                      <span className="hint mono"> {short(r.token)}</span>
                      {r.info && lookalikeToken(r.info.symbol, r.token, chainId) ? <span className="hint bad"> {t('attachLookalike').replace(/\{symbol\}/g, () => r.info!.symbol)}</span> : null}
                    </span>
                    <button className="btn small" disabled={!isHolder || !me.opened || !r.balance || !r.info} onClick={() => setPick({ type: 'erc20', row: r })}>{t('assetsWithdraw')}</button>
                  </li>
                ))}
                <li className="asset-item">
                  <span className="asset-icon">{native}</span>
                  <span className="grow"><b>{data.bnb === null ? '—' : formatUnits(data.bnb, 18)} {native}</b></span>
                  <button className="btn small" disabled={!isHolder || !me.opened || !data.bnb} onClick={() => setPick({ type: 'native', balance: data.bnb ?? 0n })}>{t('assetsWithdraw')}</button>
                </li>
                {data.tokens.filter((r) => r.token !== bem).map((r) => (
                  <li key={r.token} className="asset-item">
                    <span className="asset-icon">{(r.info?.symbol || '?').slice(0, 4)}</span>
                    <span className="grow">
                      <b>{r.balance === null || !r.info ? '—' : formatUnits(r.balance, r.info.decimals)} {r.info?.symbol ?? ''}</b>
                      <span className="hint mono"> {short(r.token)}</span>
                      {r.info && lookalikeToken(r.info.symbol, r.token, chainId) ? <span className="hint bad"> {t('attachLookalike').replace(/\{symbol\}/g, () => r.info!.symbol)}</span>
                        : !isKnownToken(r.token, chainId) ? <span className="hint warn"> {t('assetsUnknownToken')}</span> : null}
                    </span>
                    <button className="btn small" disabled={!isHolder || !me.opened || !r.balance || !r.info} onClick={() => setPick({ type: 'erc20', row: r })}>{t('assetsWithdraw')}</button>
                  </li>
                ))}
              </ul>
              <button className="btn small" onClick={() => setAdding('token')}>{t('assetsAddToken')}</button>

              <h3 className="assets-h">NFT</h3>
              {data.nfts.length ? (
                <ul className="asset-list">
                  {data.nfts.map((n) => (
                    <li key={`${n.token}:${n.tokenId}`} className="asset-item">
                      <span className="asset-icon">NFT</span>
                      <span className="grow">
                        <b>{n.info?.symbol || 'NFT'} #{n.tokenId}</b>
                        <span className="hint mono"> {short(n.token)}</span>
                        <span className={`hint ${n.owned ? 'ok' : 'bad'}`}> {n.owned === null ? t('attachUnavailable') : n.owned ? t('assetsInContainer') : t('assetsNotInContainer')}</span>
                      </span>
                      <button className="btn small" disabled={!isHolder || !me.opened || !n.owned} onClick={() => setPick({ type: 'erc721', row: n })}>{t('assetsWithdraw')}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="hint">{t('assetsNoNft')}</p>}
              <button className="btn small" onClick={() => setAdding('nft')}>{t('assetsAddNft')}</button>
              <p className="hint" style={{ marginTop: 16 }}>{t('assetsListNote')}</p>
            </>
          )}
        </div>
      </div>

      {pick && fee !== null ? (
        <WithdrawDialog me={me} wallet={wallet} pick={pick} fee={fee} onClose={() => setPick(null)} onDone={(msg) => { setPick(null); setNotice(msg); void load(); }} />
      ) : null}
      {adding ? <AddWatchDialog kind={adding} container={me.container} chainId={chainId} onClose={() => setAdding(null)} onAdded={() => { setAdding(null); void load(); }} /> : null}
    </div>
  );
}

function WithdrawDialog({ me, wallet, pick, fee, onClose, onDone }: {
  me: Endpoint; wallet: Hex; pick: Pick; fee: bigint; onClose: () => void; onDone: (notice: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState<string>(wallet);
  const [busy, setBusy] = useState(false);
  // 上一笔取出结果不明：不许再点一次（可能已经取出了）。记在本机（按容器 + 钱包），关掉窗口、刷新页面也还在，核对后手动解除
  const lockKey = `tapesend:withdraw-lock:${wallet.toLowerCase()}:${me.container.toLowerCase()}`;
  const [unknownHash, setUnknownHashState] = useState<string | null>(() => { try { return localStorage.getItem(lockKey); } catch { return null; } });
  const setUnknownHash = (v: string | null) => { setUnknownHashState(v); try { if (v) localStorage.setItem(lockKey, v); else localStorage.removeItem(lockKey); } catch { /* 忽略 */ } };
  const [error, setError] = useState('');
  const sendTx = useChainSend();
  const publicClient = useChainClient()(me.chainId);
  const native = nativeSymbol(me.chainId);
  const decimals = pick.type === 'native' ? 18 : pick.type === 'erc20' ? pick.row.info?.decimals ?? 18 : 0;
  const symbol = pick.type === 'native' ? native : pick.type === 'erc20' ? pick.row.info?.symbol ?? '' : `${pick.row.info?.symbol || 'NFT'} #${pick.row.tokenId}`;
  const balance = pick.type === 'native' ? pick.balance : pick.type === 'erc20' ? pick.row.balance ?? 0n : 1n;
  const units = pick.type === 'erc721' ? 1n : parseUnits(amount, decimals);
  const d = dest.trim();
  const destFormat = ADDRESS.test(d) && !/^0x0{40}$/i.test(d);
  // 混合大小写的地址按 EIP-55 校验和核对；全小写或全大写不做要求
  const mixed = /[a-f]/.test(d.slice(2)) && /[A-F]/.test(d.slice(2));
  const checksumOk = !mixed || (destFormat && toChecksumAddress(d) === d);
  const destOk = destFormat && checksumOk;
  const toSelf = d.toLowerCase() === me.container.toLowerCase();
  const toWallet = d.toLowerCase() === wallet.toLowerCase();
  const [confirmDest, setConfirmDest] = useState(false);
  // 电路 NFT 只能取到本钱包：取到别的地址（尤其是它自己的容器）可能让那个电路永久锁死。读不到时按"是电路"处理
  const [circuit, setCircuit] = useState<boolean | null>(pick.type === 'erc721' ? null : false);
  useEffect(() => {
    if (pick.type !== 'erc721') return;
    let alive = true;
    void isCircuitContract(pick.row.token, me.chainId).then((c) => alive && setCircuit(c));
    return () => { alive = false; };
  }, [pick, me.chainId]);
  const circuitBlocked = circuit !== false && !toWallet;
  const ok = !unknownHash && destOk && !toSelf && !circuitBlocked && units !== null && units > 0n && units <= balance && !busy;

  const go = async () => {
    if (!ok || units === null) return;
    setBusy(true);
    setError('');
    try {
      const asset = pick.type === 'native' ? { type: 'native' as const, amount: units }
        : pick.type === 'erc20' ? { type: 'erc20' as const, token: pick.row.token, amount: units }
          : { type: 'erc721' as const, token: pick.row.token, tokenId: pick.row.tokenId };
      const tx = withdrawTx(me.container, asset, dest.trim(), fee);
      const hash = await sendTx({ to: tx.to, data: tx.data, value: tx.value, chainId: me.chainId, account: wallet });
      const r = publicClient ? await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => null) : null;
      if (!r) { setUnknownHash(hash); setError(`${t('txUnknown')} ${hash}`); setBusy(false); return; }
      if (r.status !== 'success') { setError(t('assetsWithdrawFailed')); setBusy(false); return; }
      onDone(t('assetsWithdrawDone').replace(/\{what\}/g, () => (pick.type === 'erc721' ? symbol : `${amount} ${symbol}`)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = Object.keys(CONTAINER_ERRORS).find((k) => msg.includes(k.slice(2)));
      const name = code ? CONTAINER_ERRORS[code] : '';
      const x = e as { name?: string; code?: number; cause?: { code?: number; name?: string } } | null;
      const rejected = Boolean(x && (x.code === 4001 || x.cause?.code === 4001 || x.name === 'UserRejectedRequestError' || x.cause?.name === 'UserRejectedRequestError'));
      if (e instanceof ChainSwitchError) { setError(t('switchChainFailed').replace(/\{chain\}/g, () => chainName(me.chainId))); setBusy(false); return; }
      // 钱包那边出错（不是拒绝、也不是合约预检回滚）：交易可能已经发出，不许在这个窗口里再点一次，免得取出两次
      if (!rejected && !name) { setUnknownHash('wallet-error'); setError(`${t('walletErrorCheckSent')} (${msg})`); setBusy(false); return; }
      setError(name === 'NotPaid' ? t('assetsUnopened') : name === 'ListedForSale' ? t('assetsListed') : name === 'NotOwner' ? t('assetsNotHolder') : msg);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <h3>{t('assetsWithdraw')} {symbol}</h3>
        {pick.type !== 'erc721' ? (
          <div className="field">
            <label htmlFor="w-amount">{t('attachAmount')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="w-amount" className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" inputMode="decimal" autoFocus />
              <button className="btn small" onClick={() => setAmount(formatUnits(balance, decimals))}>{t('assetsMax')}</button>
            </div>
            <span className={`hint ${units !== null && units > balance ? 'bad' : ''}`}>{t('assetsInContainer')}: {formatUnits(balance, decimals)} {symbol}</span>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="w-dest">{t('assetsDest')}</label>
          <input id="w-dest" className="input mono" value={dest} onChange={(e) => { setDest(e.target.value); setConfirmDest(false); }} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {dest.trim().toLowerCase() === wallet.toLowerCase() ? <span className="hint">{t('assetsDestWallet')}</span> : null}
          {!destFormat ? <span className="hint bad">{t('assetsDestBad')}</span> : null}
          {destFormat && !checksumOk ? <span className="hint bad">{t('assetsDestChecksum')}</span> : null}
          {toSelf ? <span className="hint bad">{t('assetsDestSelf')}</span> : null}
          {circuitBlocked && !toSelf ? <span className="hint bad">{t('assetsCircuitWalletOnly')}</span> : null}
        </div>
        <p className="hint">{t('assetsFee').replace('{fee}', formatUnits(fee, 18)).replace('{symbol}', native)}</p>
        {error ? <div className="notice bad" role="alert">{error}</div> : null}
        {unknownHash ? (
          <div className="notice warn" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <span>{t('assetsWithdrawLocked')}{/^0x[0-9a-f]{64}$/i.test(unknownHash) ? <> <a href={`${explorerUrl(me.chainId)}/tx/${unknownHash}`} target="_blank" rel="noopener noreferrer">{t('viewTx')}</a></> : null}</span>
            <button className="btn small" onClick={() => { setUnknownHash(null); setError(''); }}>{t('unknownRelease')}</button>
          </div>
        ) : null}
        {confirmDest && !toWallet ? (
          <div className="notice bad" role="alert" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <b>{t('assetsDestConfirm')}</b>
            <span className="mono" style={{ overflowWrap: 'anywhere' }}>{d}</span>
            <span className="hint">{t('assetsDestConfirmHint')}</span>
            <button className="btn primary" disabled={!ok} onClick={() => void go()}>{busy ? <span className="spinner" /> : t('assetsWithdrawConfirm')}</button>
          </div>
        ) : null}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          {/* 取到别的地址：必须再确认一次，写明完整地址（钱包里看不出资产去向） */}
          <button className="btn primary" disabled={!ok} onClick={() => { if (!toWallet && !confirmDest) { setConfirmDest(true); return; } void go(); }}>{busy ? <span className="spinner" /> : t('assetsWithdrawGo')}</button>
        </div>
      </div>
    </div>
  );
}

function AddWatchDialog({ kind, container, chainId, onClose, onAdded }: { kind: 'token' | 'nft'; container: string; chainId: number; onClose: () => void; onAdded: () => void }) {
  const [token, setToken] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!ADDRESS.test(token.trim())) { setName(null); return; }
    let alive = true;
    void tokenInfo(kind === 'token' ? 'erc20' : 'erc721', token.trim(), chainId).then((i) => alive && setName(i ? `${i.name || i.symbol} (${i.symbol})` : ''));
    return () => { alive = false; };
  }, [kind, token, chainId]);
  const ok = ADDRESS.test(token.trim()) && (kind === 'token' || /^\d{1,78}$/.test(tokenId.trim()));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <h3>{kind === 'token' ? t('assetsAddToken') : t('assetsAddNft')}</h3>
        <div className="field">
          <label htmlFor="watch-token">{kind === 'token' ? t('attachTokenAddress') : t('attachNftAddress')}</label>
          <input id="watch-token" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" autoFocus autoCapitalize="off" spellCheck={false} />
          {name === '' ? <span className="hint bad">{t('attachNotToken')}</span> : name ? <span className="hint">{name}</span> : null}
        </div>
        {kind === 'nft' ? (
          <div className="field">
            <label htmlFor="watch-id">{t('attachNftId')}</label>
            <input id="watch-id" className="input mono" value={tokenId} onChange={(e) => setTokenId(e.target.value)} inputMode="numeric" />
          </div>
        ) : null}
        <div className="actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" disabled={!ok} onClick={() => { watchAsset(container, kind === 'token' ? { token: token.trim() as Hex } : { token: token.trim() as Hex, tokenId: tokenId.trim() }); onAdded(); }}>{t('attachAdd')}</button>
        </div>
      </div>
    </div>
  );
}
