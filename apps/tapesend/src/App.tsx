import { useEffect, useState } from 'react';
import { WalletButton } from './wallet/WalletButton';
import { BrowserView } from './browser/BrowserView';
import { MessagesView } from './messages/MessagesView';
import { IconGlobe, IconInbox } from './icons';
import { t, locale, setLocale } from './i18n';

type Tab = 'messages' | 'browser';

export function App() {
  const [tab, setTab] = useState<Tab>('messages');
  // 桌面版：系统里点了 tape:// 链接，切到浏览器标签
  useEffect(() => window.tapesendDesktop?.browser.onOpened(() => setTab('browser')), []);
  // 桌面版：主进程的弹窗和链上网站提示页跟着界面语言
  useEffect(() => { window.tapesendDesktop?.setLocale?.(locale); }, []);
  return (
    <div className="app">
      <header className="topbar">
        <div className="title">{tab === 'messages' ? t('appName') : t('browserHome')}</div>
        <div className="topbar-actions">
          <button className="lang-btn" onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')} title={locale === 'zh' ? 'Switch to English' : '切换到中文'} aria-label={locale === 'zh' ? 'Switch to English' : '切换到中文'}>
            {locale === 'zh' ? 'EN' : '中文'}
          </button>
          <WalletButton />
        </div>
      </header>
      <main className="main">
        {/* 两个标签都保持挂载：切走再切回，浏览器页面和写到一半的消息都还在 */}
        <section hidden={tab !== 'messages'} style={{ height: '100%' }}>
          <MessagesView />
        </section>
        <section hidden={tab !== 'browser'} style={{ height: '100%' }}>
          <BrowserView active={tab === 'browser'} />
        </section>
      </main>
      <nav className="tabbar" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>
          <IconInbox />
          {t('tabMessages')}
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'browser'} onClick={() => setTab('browser')}>
          <IconGlobe />
          {t('tabBrowser')}
        </button>
      </nav>
    </div>
  );
}
