// 钱包连接。配置了 Reown projectId 时用 AppKit（扫码 / 手机钱包 / 浏览器插件都支持）；
// 没配时退回只支持浏览器插件钱包，方便本地开发。
import { createAppKit } from '@reown/appkit/react';
import { bsc as appkitBsc } from '@reown/appkit/networks';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createConfig, http, type Config } from 'wagmi';
import { bsc } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { platform, siteOrigin } from '../platform';

const projectId: string = import.meta.env.VITE_REOWN_PROJECT_ID ?? '';
export const hasAppKit = projectId.length > 0;

const rpcUrl = import.meta.env.VITE_BSC_RPC ?? 'https://bsc-dataseed.bnbchain.org';

let appKit: ReturnType<typeof createAppKit> | null = null;
let config: Config;

if (hasAppKit) {
  const adapter = new WagmiAdapter({
    networks: [appkitBsc],
    projectId,
    ssr: false,
    transports: { [bsc.id]: http(rpcUrl) },
  });
  const origin = siteOrigin();
  appKit = createAppKit({
    adapters: [adapter],
    networks: [appkitBsc],
    defaultNetwork: appkitBsc,
    projectId,
    allowUnsupportedChain: false,
    metadata: {
      name: 'TapeSend',
      description: 'Messages between TapeOut circuit containers, with the TapeKit browser',
      url: origin,
      icons: [`${origin}/icon.svg`],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  });
  config = adapter.wagmiConfig;
  // 手机 App 和桌面版的界面不是 https 网址，核验框架也被内容安全策略禁止（frame-src 'none'），
  // 核验每次白等 5 秒、拿到的仍是空结果。2026-09-18 实测：恢复核验并不能解决"钱包弹两次"，所以非网页版继续跳过
  if (platform() !== 'web') {
    void appKit.getUniversalProvider().then((provider) => {
      const core = (provider as unknown as { client?: { core?: { verify?: { register?: unknown } } } } | undefined)?.client?.core;
      if (core?.verify) core.verify.register = async () => '';
    }).catch(() => {});
  }
} else {
  config = createConfig({
    chains: [bsc],
    connectors: [injected({ shimDisconnect: true })],
    transports: { [bsc.id]: http(rpcUrl) },
  });
}

export const wagmiConfig = config;
export const openWalletModal = () => appKit?.open();

/**
 * 能不能让这个连接签钥匙文字（TAP-10 §4.2）。
 * AppKit 会拉 Reown 后台的项目配置，后台一旦开了邮箱 / 社交登录或 Reown 登录，本地的关闭设置会被覆盖：
 * 内嵌钱包的签名不一定确定，登录流程还会让用户签 EIP-4361 文字。这里在签名前再核对一次，发现就拒绝。
 * 上线前也要在 Reown 后台把这些功能关掉。
 */
export function keySigningBlocked(connectorId: string | undefined): string | null {
  if (connectorId && /^(auth|w3mauth|ID_AUTH)$/i.test(connectorId)) return 'embedded-wallet';
  if (!appKit) return null;
  const remote = (appKit as unknown as { remoteFeatures?: { email?: boolean; socials?: unknown; reownAuthentication?: boolean } }).remoteFeatures ?? {};
  if (remote.email || (Array.isArray(remote.socials) && remote.socials.length > 0) || remote.reownAuthentication) return 'remote-login-enabled';
  return null;
}

/** 钱包弹窗开关：桌面版要在弹窗打开时让网站视图让开 */
export function onWalletModal(handler: (open: boolean) => void): () => void {
  if (!appKit) return () => {};
  return appKit.subscribeState((s) => handler(Boolean(s.open)));
}
