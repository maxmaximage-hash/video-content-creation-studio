const HOST_PATTERN = /(^|\.)(?:bilibili\.com|b23\.tv|bili2233\.cn)$/i;

export const bilibiliAdapter = Object.freeze({
  key: "bilibili",
  label: "B站",
  loginUrl: "https://passport.bilibili.com/login",
  healthUrl: "https://space.bilibili.com/",
  referer: "https://www.bilibili.com/",
  port: 9333,
  authenticatedCookies: /^(?:SESSDATA|DedeUserID)$/i,
  challengeTextPattern: /验证码|安全验证|访问频繁|账号存在风险|请完成验证/i,
  challengeUrlPattern: /(?:bilibili\.com|biligame\.com)\/[^?#]*(?:captcha|verify|safecenter)/i,
  loginPattern: /登录|扫码登录|密码登录|短信登录/i,
  authenticatedPagePattern: /动态|投稿|收藏|历史记录|个人中心|我的/i,
  responsePattern: /x\/(?:web-interface\/view|space\/wbi\/arc\/search)|player\/wbi\/playurl/i,
  capturePlan: Object.freeze(["public_quick_path", "session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({ delaysMs: Object.freeze([5000, 15000, 45000, 120000, 300000]), maxDelayMs: 300000 }),
  matchesHost(hostname = "") { return HOST_PATTERN.test(String(hostname)); },
  matchesValue(value = "") { return /bilibili|b23\.tv|bili2233|B站/i.test(String(value)); },
  normalizeCaptureUrl(url) { return url; },
});
