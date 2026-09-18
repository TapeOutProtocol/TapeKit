// 链上网站视图的预加载脚本：不暴露任何接口，只在页面脚本运行之前拿掉实时通道接口。
// 这只是纵深防御（动态创建的空白子框架、Worker 里它不运行）；真正挡住链下连接的是主进程里的代理、UDP 策略、请求过滤器和 connect-src。
// WebRTC 走 UDP / TCP 直连，不经过会话的请求过滤器：能拿到访问者的公网 IP，也能建立链下通道把内容注入"已验证"页面。
// WebTransport 另由响应头里的 connect-src 挡住（它在 Worker 里也能用）。
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'WebTransport']) {
      try {
        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      } catch {
        // 已经没有这个接口
      }
    }
    try {
      // 网站不能弹系统打印面板（在后台时也能弹，会盖住窗口）
      Object.defineProperty(globalThis, 'print', { value: () => {}, writable: false, configurable: false });
    } catch {
      // 忽略
    }
    try {
      // 在原型上改 getter：只改实例属性的话，用 Navigator.prototype 的 getter 仍能拿到设备列表
      Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined, configurable: false });
    } catch {
      // 忽略
    }
  },
});
