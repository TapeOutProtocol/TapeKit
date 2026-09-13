// 地址栏：输入「tape 空格 4246.0.tape」回车。设了网关域名就在网关的真实来源下打开；否则在扩展的查看器页里打开（沙盒预览）。
import { getGateway, targetUrl } from './gateway.js';

chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({ description: '打开链上网站：输入 4246.0.tape、#4246@0 或容器地址' });
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const url = targetUrl(text, await getGateway());
  if (disposition === 'currentTab') chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});
