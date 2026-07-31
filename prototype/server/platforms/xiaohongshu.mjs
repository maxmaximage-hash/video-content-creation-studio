const HOST_PATTERN = /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.(?:com|cn)$/i;

export const xiaohongshuAdapter = Object.freeze({
  key: "xiaohongshu",
  label: "小红书",
  loginUrl: "https://www.xiaohongshu.com/explore?login=1",
  healthUrl: "https://www.xiaohongshu.com/explore",
  referer: "https://www.xiaohongshu.com/",
  port: 9332,
  authenticatedCookies: /^(?:web_session)$/i,
  challengeTextPattern: /captcha|verify|验证码|安全验证|滑块|环境异常|访问过于频繁|账号存在风险/i,
  challengeUrlPattern: /(?:xiaohongshu\.com|xhscdn\.com)\/[^?#]*(?:captcha|website-login\/captcha|verifycenter|rc-verifycenter|nocaptcha)/i,
  loginPattern: /扫码登录|手机号登录|密码登录|登录后|请先登录|立即登录/i,
  authenticatedPagePattern: /发现|关注|我的|笔记|收藏/i,
  responsePattern: /api\/sns\/web\/v1\/feed/i,
  capturePlan: Object.freeze(["public_quick_path", "session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({
    delaysMs: Object.freeze([8000, 20000, 60000, 150000, 300000]),
    maxDelayMs: 300000,
  }),
  matchesHost(hostname = "") {
    return HOST_PATTERN.test(String(hostname));
  },
  matchesValue(value = "") {
    return /xiaohongshu|xhslink|小红书/i.test(String(value));
  },
  normalizeCaptureUrl(url) {
    const parsed = new URL(url);
    if (/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/^\/discovery\/item\/([A-Za-z0-9]+)\/?$/);
      if (match) parsed.pathname = `/explore/${match[1]}`;
    }
    return parsed.toString();
  },
});
