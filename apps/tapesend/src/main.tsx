import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './wallet/config';
import { App } from './App';
import { platform } from './platform';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const p = platform();
document.documentElement.classList.add(`platform-${p}`);
if (p === 'electron' && window.tapesendDesktop?.platform === 'darwin') document.documentElement.classList.add('electron-mac');

// 手机 App 必须是用手机配置构建的（界面不许嵌任何框架，否则框架能调用原生通道）：拿错了构建产物就不启动
const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
const wrongNativeBuild = (p === 'ios' || p === 'android') && !/frame-src 'none'/.test(csp);

if (wrongNativeBuild) {
  document.getElementById('root')!.textContent = 'TapeSend: this app was packaged with the web build. Rebuild with npm run cap:sync.';
} else createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
