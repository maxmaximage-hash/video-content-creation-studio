const HOST_PATTERN = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i;

export const douyinAdapter = Object.freeze({
  key: "douyin",
  label: "抖音",
  loginUrl: "https://www.douyin.com/?login=1",
  healthUrl: "https://www.douyin.com/",
  referer: "https://www.douyin.com/",
  port: 9331,
  authenticatedCookies: /^(?:sessionid|sessionid_ss|sid_guard)$/i,
  challengeTextPattern: /captcha|verify|验证码|安全验证|滑块|环境异常|访问过于频繁|账号存在风险/i,
  challengeUrlPattern: /(?:^|\/\/)rmc\.bytedance\.com\/|(?:douyin\.com|bytedance\.com|yhgfb-cn-static\.com)\/[^?#]*(?:captcha|verifycenter|rc-verifycenter|nocaptcha)/i,
  loginPattern: /扫码登录|手机号登录|密码登录|登录后|请先登录|立即登录/i,
  authenticatedPagePattern: /推荐|关注|作品|点赞|评论|分享|发布时间/i,
  responsePattern: /aweme\/v1\/web\/aweme\/detail/i,
  capturePlan: Object.freeze(["public_quick_path", "session_capture", "fallback_capture"]),
  retryPolicy: Object.freeze({
    delaysMs: Object.freeze([5000, 15000, 45000, 120000, 300000]),
    maxDelayMs: 300000,
  }),
  matchesHost(hostname = "") {
    return HOST_PATTERN.test(String(hostname));
  },
  matchesValue(value = "") {
    return /douyin|iesdouyin|抖音/i.test(String(value));
  },
  normalizeCaptureUrl(url) {
    return url;
  },
});

export function classifyDouyinFallbackResponse(payload = {}) {
  const statusCode = Number(payload?.status_code ?? payload?.statusCode ?? 0);
  const statusMessage = String(payload?.status_msg ?? payload?.statusMessage ?? "");
  const contractBlocked = statusCode === 11110 || /encrypt_data_miss|缺少加密参数/i.test(statusMessage);
  if (!contractBlocked) return null;
  return {
    blocked: true,
    parserContractFailure: false,
    retryable: true,
    errorCode: "FALLBACK_UNAVAILABLE",
    message: "抖音备用通道暂时不可用，稍后自动重试",
  };
}
