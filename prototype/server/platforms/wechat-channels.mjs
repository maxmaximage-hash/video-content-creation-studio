const HOST_PATTERN = /(^|\.)(?:weixin\.qq\.com|channels\.weixin\.qq\.com)$/i;

export const wechatChannelsAdapter = Object.freeze({
  key: "wechat-channels",
  label: "视频号",
  loginUrl: "https://channels.weixin.qq.com/login.html",
  healthUrl: "https://channels.weixin.qq.com/",
  referer: "https://channels.weixin.qq.com/",
  port: 9334,
  authenticatedCookies: /^(?:session|token|wxuin|finder_uin)$/i,
  challengeTextPattern: /验证码|安全验证|访问频繁|操作异常|请完成验证/i,
  challengeUrlPattern: /(?:weixin\.qq\.com|qq\.com)\/[^?#]*(?:captcha|verify|challenge)/i,
  loginPattern: /扫码登录|微信扫码|请使用微信扫描二维码|登录/i,
  authenticatedPagePattern: /视频号|首页|动态|创作者中心|账号管理/i,
  responsePattern: /(?:finder|channels)[^?#]*(?:feed|post|detail|profile)/i,
  capturePlan: Object.freeze(["session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({ delaysMs: Object.freeze([10000, 30000, 90000, 180000, 300000]), maxDelayMs: 300000 }),
  matchesHost(hostname = "") { return HOST_PATTERN.test(String(hostname)); },
  matchesValue(value = "") { return /channels\.weixin|weixin\.qq\.com|视频号/i.test(String(value)); },
  normalizeCaptureUrl(url) { return url; },
});
