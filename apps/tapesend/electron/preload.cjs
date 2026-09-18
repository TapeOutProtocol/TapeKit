// 应用界面的预加载脚本：只暴露浏览器视图的几条指令和状态订阅。链上网站的视图没有 preload。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tapesendDesktop', {
  platform: process.platform,
  /** 界面语言（zh / en）：主进程的弹窗和链上网站提示页跟着用 */
  setLocale: (l) => ipcRenderer.send('ui:locale', l === 'en' ? 'en' : 'zh'),
  browser: {
    show: (bounds) => ipcRenderer.send('browser:show', bounds),
    hide: () => ipcRenderer.send('browser:hide'),
    navigate: (input) => ipcRenderer.send('browser:navigate', String(input)),
    back: () => ipcRenderer.send('browser:back'),
    forward: () => ipcRenderer.send('browser:forward'),
    reload: () => ipcRenderer.send('browser:reload'),
    /** 界面打开弹窗时让网站视图让开，关闭后恢复 */
    overlay: (open) => ipcRenderer.send('ui:overlay', Boolean(open)),
    /** 系统里点了 tape:// 链接，主进程已在浏览器视图打开 */
    onOpened: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('browser:opened', listener);
      return () => ipcRenderer.removeListener('browser:opened', listener);
    },
    onState: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('browser:state', listener);
      return () => ipcRenderer.removeListener('browser:state', listener);
    },
  },
});
