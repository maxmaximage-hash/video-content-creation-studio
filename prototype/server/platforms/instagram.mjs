const HOST_PATTERN = /(^|\.)instagram\.com$/i;

export const instagramAdapter = Object.freeze({
  key: "instagram",
  label: "Instagram",
  loginUrl: "https://www.instagram.com/accounts/login/",
  healthUrl: "https://www.instagram.com/",
  referer: "https://www.instagram.com/",
  port: 9336,
  authenticatedCookies: /^(?:sessionid|ds_user_id)$/i,
  challengeTextPattern: /challenge|captcha|verify|验证码|确认是你本人|suspicious login/i,
  challengeUrlPattern: /instagram\.com\/[^?#]*(?:challenge|checkpoint|captcha)/i,
  loginPattern: /log in|登录|手机号、用户名或邮箱|password/i,
  authenticatedPagePattern: /首页|搜索|探索|Reels|消息|Home|Explore/i,
  responsePattern: /(?:graphql\/query|api\/v1\/(?:media|feed|users))/i,
  capturePlan: Object.freeze(["public_quick_path", "session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({ delaysMs: Object.freeze([10000, 30000, 90000, 180000, 300000]), maxDelayMs: 300000 }),
  matchesHost(hostname = "") { return HOST_PATTERN.test(String(hostname)); },
  matchesValue(value = "") { return /instagram/i.test(String(value)); },
  normalizeCaptureUrl(url) { return url; },
});
