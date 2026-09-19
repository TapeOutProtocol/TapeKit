import { useState } from 'react';
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { bsc, base, xLayer } from 'wagmi/chains';
import { hasAppKit, openWalletModal } from './config';
import { t } from '../i18n';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [noWallet, setNoWallet] = useState(false);

  if (!isConnected || !address) {
    return (
      <>
      {noWallet ? <span className="hint bad" role="alert" style={{ marginRight: 8, maxWidth: 360 }}>{t('noWalletFound')}</span> : null}
      <button
        className="btn primary wallet-btn"
        disabled={isPending}
        onClick={() => {
          if (hasAppKit) { void openWalletModal(); return; }
          // 没配扫码连接（开发模式），又没有浏览器钱包插件（例如桌面版）：点了什么都不会发生，要说清楚
          if (typeof (window as { ethereum?: unknown }).ethereum === 'undefined') { setNoWallet(true); return; }
          if (connectors[0]) connect({ connector: connectors[0] });
        }}
        title={noWallet ? t('noWalletFound') : undefined}
      >
        {t('connect')}
      </button>
      </>
    );
  }
  // 支持的链：BNB Chain、Base、X Layer（发交易时会自动切到身份所在的链）；其他链才提示切换
  const supported: Record<number, string> = { [bsc.id]: 'BNB', [base.id]: 'Base', [xLayer.id]: 'X Layer' };
  if (!supported[chainId]) {
    return (
      <button className="btn wallet-btn" onClick={() => switchChain({ chainId: bsc.id })}>
        {t('wrongChain')}
      </button>
    );
  }
  return (
    <button
      className="btn wallet-btn"
      title={address}
      onClick={() => {
        if (hasAppKit) void openWalletModal();
        else disconnect();
      }}
    >
      <span className="wallet-dot" aria-hidden />
      <span className="mono">{short(address)}</span>
      <span className="hint" style={{ marginLeft: 6 }}>{supported[chainId]}</span>
    </button>
  );
}
