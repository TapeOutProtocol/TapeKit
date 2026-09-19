// 运行平台：网页、Electron（mac / Windows）、Capacitor（iOS / Android）。
declare global {
  interface Window {
    tapesendDesktop?: {
      platform: string;
      setLocale?(l: 'zh' | 'en'): void;
      browser: {
        show(bounds: { x: number; y: number; width: number; height: number }): void;
        hide(): void;
        navigate(input: string): void;
        back(): void;
        forward(): void;
        reload(): void;
        overlay(open: boolean): void;
        onOpened(handler: () => void): () => void;
        onState(handler: (state: DesktopBrowserState) => void): () => void;
      };
    };
    Capacitor?: { isNativePlatform(): boolean; getPlatform(): string };
  }
}

export interface DesktopBrowserState {
  url: string;
  display: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  tape: { status: string; statusText?: string; verified?: number; files?: number; block?: string | number; unverified?: string[]; page?: string | null; offchain?: string[] } | null;
}

export type Platform = 'web' | 'electron' | 'ios' | 'android';

export function platform(): Platform {
  if (typeof window === 'undefined') return 'web';
  if (window.tapesendDesktop) return 'electron';
  const cap = window.Capacitor;
  if (cap?.isNativePlatform()) return cap.getPlatform() === 'ios' ? 'ios' : 'android';
  return 'web';
}

export const isNative = () => platform() !== 'web';

/** 钱包里显示的站点身份：只有网页版用真实 origin；桌面和手机 App 一律用官网（Android 的页面地址是 https://localhost） */
export function siteOrigin(): string {
  if (platform() !== 'web') return 'https://www.tapesend.com';
  const o = typeof window === 'undefined' ? '' : window.location.origin;
  return /^https:\/\//.test(o) ? o : 'https://www.tapesend.com';
}
