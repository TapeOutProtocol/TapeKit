import { useEffect, useRef, useState } from 'react';
import { parseInput } from '../../../../kernel/src/name.js';
import { IconBack, IconForward, IconReload, IconShield, IconHome } from '../icons';
import { isNative, platform, type DesktopBrowserState } from '../platform';
import { onWalletModal } from '../wallet/config';
import { t } from '../i18n';
import { resolveSite, type SiteSummary } from '../data/chain';

// 地址栏输入 → 要打开的东西。
//   链上名字：桌面版交给主进程的 tape:// 协议（真实独立来源）；网页版和手机版走 tapekit.org 网关子域
//   （同样是独立来源，文件由网关页面里的 Service Worker 在本地读链、逐个校验）。
//   普通网址：桌面版照常打开；其它平台在新窗口打开（大多数网站禁止被嵌入）。
type Target = { kind: 'tape'; tokenId: bigint; cpu: bigint; path: string; display: string } | { kind: 'web'; url: string; display: string };

function toTarget(raw: string): Target | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const p = parseInput(s);
    if (p.kind === 'name') {
      const path = p.path || '';
      return { kind: 'tape', tokenId: p.tokenId, cpu: p.cpu, path, display: `${p.tokenId}.${p.cpu}${path ? '/' + path : ''}` };
    }
  } catch {
    // 不是链上名字，继续按网址处理
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'web', url: s, display: s };
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return { kind: 'web', url: `https://${s}`, display: `https://${s}` };
  return null;
}

const gatewayUrl = (x: Extract<Target, { kind: 'tape' }>) => `https://${x.tokenId}-${x.cpu}.tapekit.org/${x.path}`;


export function BrowserView({ active }: { active: boolean }) {
  const desktop = platform() === 'electron' ? window.tapesendDesktop : undefined;
  if (desktop) return <DesktopBrowser active={active} />;
  return <FrameBrowser native={isNative()} />;
}

/**
 * 手机 App 里不把链上网站嵌进应用页面：Capacitor 的原生消息通道对页面里的所有框架开放，
 * 嵌进来的网站能调用原生插件。改用系统的安全浏览器视图（iOS SFSafariViewController、Android Custom Tabs）打开，
 * 它和 App 的页面完全隔离，Service Worker 网关也能正常工作。
 */
async function openNative(url: string) {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'fullscreen' });
}

// 网页版和手机版：文件由网关页面里的 Service Worker 逐个校验，外壳这里只知道名字解析的结果，
// 所以徽章只说"名字已解析"，不说"已验证"
function Badge({ summary, loading }: { summary: SiteSummary | null; loading: boolean }) {
  if (loading) return <span className="chip"><span className="spinner" style={{ width: 12, height: 12 }} />{t('loading')}</span>;
  if (!summary) return null;
  if (summary.status === 'ok') return <span className="chip ok"><IconShield />{t('resolved')}</span>;
  return <span className="chip warn">{summary.statusText}</span>;
}

function FrameBrowser({ native }: { native: boolean }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<Target[]>([]);
  const [index, setIndex] = useState(-1);
  const [summary, setSummary] = useState<SiteSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoads, setFrameLoads] = useState(0);
  // 预热：先用隐藏框架打开网关的状态页（纯 HTML，不运行网站代码），让网关装好 Service Worker、完成首次自动刷新；
  // 之后再挂上真正显示网站的框架，它的任何第二次加载都算"在框内跳转"
  const [warmFor, setWarmFor] = useState('');
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = index >= 0 ? history[index] : undefined;
  // 框架里的网站自己跳转后，外壳不知道现在显示的是什么：徽章降级（跨源框架只能数加载次数）
  useEffect(() => { setFrameLoads(0); }, [current, reloadKey]);
  const currentUrl = current && current.kind === 'tape' ? gatewayUrl(current) : '';
  const warm = !currentUrl || native || warmFor === currentUrl;
  const warmDone = (url: string) => {
    if (warmTimer.current) clearTimeout(warmTimer.current);
    // 最后一次加载后 4 秒内没有再刷新，就算预热完成（网关首次安装 Service Worker 再刷新要 2.5–3 秒）
    warmTimer.current = setTimeout(() => setWarmFor(url), 4000);
  };
  const resolvedOk = summary?.status === 'ok';
  useEffect(() => {
    // 预热超时从预热框架真正挂上（名字解析完成）才开始算
    if (warm || !currentUrl || !resolvedOk) return;
    const timeout = setTimeout(() => setWarmFor(currentUrl), 15_000);
    return () => clearTimeout(timeout);
  }, [warm, currentUrl, resolvedOk]);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError('');
    if (!current || current.kind !== 'tape') return;
    setLoading(true);
    resolveSite(`${current.tokenId}.${current.cpu}`)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [current, reloadKey]);

  const go = (raw: string) => {
    const target = toTarget(raw);
    if (!target) { setError(t('recipientBad')); return; }
    if (target.kind === 'web') {
      if (native) void openNative(target.url);
      else window.open(target.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const next = [...history.slice(0, index + 1), target];
    setHistory(next);
    setIndex(next.length - 1);
    setInput(target.display);
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn" aria-label={t('back')} disabled={index <= 0} onClick={() => { setIndex(index - 1); setInput(history[index - 1]?.display ?? ''); }}><IconBack /></button>
        <button className="icon-btn" aria-label={t('forward')} disabled={index >= history.length - 1} onClick={() => { setIndex(index + 1); setInput(history[index + 1]?.display ?? ''); }}><IconForward /></button>
        <button className="icon-btn" aria-label={t('reload')} disabled={!current} onClick={() => setReloadKey((k) => k + 1)}><IconReload /></button>
        <form className="omni" onSubmit={(e) => { e.preventDefault(); go(input); }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组字时的回车不算提交
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go(input);
              }
            }}
            placeholder={t('addressPlaceholder')}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" enterKeyHint="go"
            aria-label={t('addressPlaceholder')}
          />
          {frameLoads >= 2 && !native ? <span className="chip warn" title={t('frameNavigatedText')}>{t('frameNavigated')}</span> : <Badge summary={summary} loading={loading} />}
        </form>
      </div>
      <div className="browser-body">
        {current && current.kind === 'tape' && summary?.status === 'ok' && native ? (
          <div className="scroll">
            <div className="browser-home">
              <h2 className="mono">{current.display}</h2>
              <p className="hint">{t('nativeOpenText')}</p>
              <button className="btn primary" onClick={() => void openNative(gatewayUrl(current))}>{t('nativeOpen')}</button>
            </div>
          </div>
        ) : current && current.kind === 'tape' && summary?.status === 'ok' && !warm ? (
          <div className="scroll">
            <div className="browser-home">
              <span className="spinner" />
              <iframe
                key={`warm:${gatewayUrl(current)}`}
                src={`https://${current.tokenId}-${current.cpu}.tapekit.org/.tape/status`}
                title="warm-up"
                aria-hidden
                tabIndex={-1}
                style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0 }}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin"
                onLoad={() => warmDone(gatewayUrl(current))}
              />
            </div>
          </div>
        ) : current && current.kind === 'tape' && summary?.status === 'ok' ? (
          <iframe
            key={`${gatewayUrl(current)}#${reloadKey}`}
            src={gatewayUrl(current)}
            title={current.display}
            allow="clipboard-write"
            referrerPolicy="no-referrer"
            onLoad={() => setFrameLoads((n) => n + 1)}
            // 不给顶层跳转权限：链上网站不能把整个 TapeSend 换成仿冒页（SPEC §7.6）
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="scroll">
            <div className="browser-home">
              {error ? <div className="notice bad" role="alert">{error}</div> : null}
              {summary && summary.status !== 'ok' ? <div className="notice warn">{summary.statusText}</div> : null}
              {!current ? (
                <>
                  <h2>{t('browserHome')}</h2>
                  <p className="hint">{t('browserHomeText')}</p>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DesktopBrowser({ active }: { active: boolean }) {
  const api = window.tapesendDesktop!.browser;
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(false);
  // 主页：隐藏网站视图、显示起始页（不改动网站的浏览历史，点"后退"回到刚才的网站）
  const [home, setHome] = useState(false);
  // 刚按回车去的地址：新页面的状态回来之前，地址栏一直显示它，不闪回旧地址
  const going = useRef<{ typed: string; from: string; at: number } | null>(null);

  // 最新的页面状态和是否在主页（给回调里用）
  const stateRef = useRef(state);
  stateRef.current = state;
  const homeRef = useRef(home);
  homeRef.current = home;
  useEffect(() => api.onState((s) => {
    setState(s);
    const g = going.current;
    // 只有"旧页面还在、新页面正在加载"时才继续显示输入的地址；加载停了还是旧地址，说明这次跳转被取消了，立刻显示真实地址
    if (g && s.url === g.from && s.loading && Date.now() - g.at < 15_000) return;
    going.current = null;
    // 停在主页时，后台网站自己换页不能改写主页的输入框
    if (!editing && !homeRef.current) setInput(s.display);
  }), [api, editing]);
  const go = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return;
    const g = { typed, from: state?.url ?? '', at: Date.now() };
    going.current = g;
    setInput(typed);
    setHome(false);
    api.navigate(typed);
    // 输入的不是链上网站（例如外链，主进程只弹确认、不跳转）：一会儿还没开始加载，就换回真实地址，
    // 免得地址栏显示输入的外链、旁边却是旧网站的"已验证"徽章
    setTimeout(() => {
      if (going.current !== g || stateRef.current?.loading) return;
      going.current = null;
      setInput(stateRef.current?.display ?? '');
    }, 1500);
  };
  // 钱包弹窗打开时网站视图让开：否则网站画面会盖住弹窗，还能在同一位置画一个假二维码
  useEffect(() => onWalletModal((open) => api.overlay(open)), [api]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (!active || !state?.url || home) { api.hide(); return; }
    const push = () => {
      const r = el.getBoundingClientRect();
      api.show({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    return () => { ro.disconnect(); window.removeEventListener('resize', push); api.hide(); };
  }, [api, active, state?.url, home]);

  const tape = state?.tape;
  const blocked = tape?.offchainBlocked?.length ?? 0;
  let badge = null;
  if (state?.loading) badge = <span className="chip"><span className="spinner" style={{ width: 12, height: 12 }} />{t('loading')}</span>;
  else if (tape?.unverified?.length || tape?.page === 'unverified') badge = <span className="chip bad">{t('verifyFailed')}</span>;
  // 只有"当前页面本身是校验通过的链上文件"才显示已验证；404、出错页、状态页都不算
  else if (tape?.status === 'ok' && tape.page === 'verified') {
    badge = (
      <span className="chip ok" title={blocked ? tape.offchainBlocked!.join('\n') : undefined}>
        <IconShield />{t('verified')}{blocked ? ` ${t('offchainBlocked').replace('{n}', String(blocked))}` : ''}
      </span>
    );
  } else if (tape?.status === 'ok') badge = <span className="chip warn">{tape.page === 'not-found' ? t('pageNotFound') : t('pageError')}</span>;
  else if (tape) badge = <span className="chip warn">{tape.statusText ?? tape.status}</span>;

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn" aria-label={t('browserHomeBtn')} title={t('browserHomeBtn')} onClick={() => { going.current = null; setHome(true); setInput(''); }}><IconHome /></button>
        <button className="icon-btn" aria-label={t('back')} disabled={home ? !state?.url : !state?.canBack} onClick={() => { if (home) { setHome(false); setInput(state?.display ?? ''); } else api.back(); }}><IconBack /></button>
        <button className="icon-btn" aria-label={t('forward')} disabled={!state?.canForward} onClick={() => api.forward()}><IconForward /></button>
        <button className="icon-btn" aria-label={t('reload')} disabled={!state?.url || home} onClick={() => api.reload()}><IconReload /></button>
        <form className="omni" onSubmit={(e) => { e.preventDefault(); go(input); (document.activeElement as HTMLElement | null)?.blur(); }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={(e) => { setEditing(true); e.target.select(); }}
            onBlur={() => { setEditing(false); if (going.current) return; setInput(home ? '' : state?.display ?? ''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && input.trim()) {
                e.preventDefault();
                go(input);
                e.currentTarget.blur();
              }
            }}
            placeholder={t('addressPlaceholder')}
            spellCheck={false}
            aria-label={t('addressPlaceholder')}
          />
          {home ? null : badge}
        </form>
      </div>
      <div className="browser-body" ref={hostRef}>
        {!state?.url || home ? (
          <div className="scroll">
            <div className="browser-home">
              <h2>{t('browserHome')}</h2>
              <p className="hint">{t('browserHomeText')}</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
