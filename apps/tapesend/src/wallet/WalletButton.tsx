import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { bsc } from 'wagmi/chains';
import { hasAppKit, openWalletModal } from './config';
import { t } from '../i18n';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected || !address) {
    return (
      <button
        className="btn primary wallet-btn"
        disabled={isPending}
        onClick={() => {
          if (hasAppKit) void openWalletModal();
          else if (connectors[0]) connect({ connector: connectors[0] });
        }}
      >
        {t('connect')}
      </button>
    );
  }
  if (chainId !== bsc.id) {
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
    </button>
  );
}
