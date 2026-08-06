const HOST_PATTERN = /(^|\.)(?:youtube\.com|youtu\.be)$/i;

export const youtubeAdapter = Object.freeze({
  key: "youtube",
  label: "YouTube",
  loginUrl: "https://accounts.google.com/ServiceLogin?service=youtube",
  healthUrl: "https://www.youtube.com/feed/you",
  referer: "https://www.youtube.com/",
  port: 9335,
  authenticatedCookies: /^(?:SAPISID|__Secure-3PAPISID|LOGIN_INFO)$/i,
  challengeTextPattern: /captcha|verify|验证|unusual traffic|not a bot|confirm you.re not a bot/i,
  challengeUrlPattern: /(?:google\.com|youtube\.com)\/[^?#]*(?:challenge|captcha|sorry|signin\/v2\/challenge)/i,
  loginPattern: /sign in|登录|choose an account|使用您的 Google 帐号/i,
  authenticatedPagePattern: /YouTube|订阅内容|历史记录|稍后观看|Your videos|History/i,
  responsePattern: /youtubei\/v1\/(?:player|browse|next)/i,
  capturePlan: Object.freeze(["public_quick_path", "session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({ delaysMs: Object.freeze([8000, 20000, 60000, 150000, 300000]), maxDelayMs: 300000 }),
  matchesHost(hostname = "") { return HOST_PATTERN.test(String(hostname)); },
  matchesValue(value = "") { return /youtube|youtu\.be/i.test(String(value)); },
  normalizeCaptureUrl(url) { return url; },
});
