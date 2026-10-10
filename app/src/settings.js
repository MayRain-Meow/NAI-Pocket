// Public endpoints only. Credentials are provided by the person using this device.
export const settings = Object.freeze({
  naiImageApi: 'https://image.novelai.net/ai/generate-image',
  naiAugmentApi: 'https://image.novelai.net/ai/augment-image', naiUpscaleApi: 'https://image.novelai.net/ai/upscale',
  naiSubscriptionApi: 'https://image.novelai.net/user/subscription', naiTagApi: 'https://image.novelai.net/ai/generate-image/suggest-tags',
  naiVibeApi: 'https://image.novelai.net/ai/encode-vibe',
  rbqNaiImageApi: 'https://gnai.rbq.my/ai/generate-image', rbqNaiUserInfoApi: 'https://gnai.rbq.my/user/info',
  naiTimeoutMs: 300000, maxBatchSize: 12, maxQueueSize: 50, maxStormSize: 1000,
  maxRetries: 2, rateLimitRetries: 6, rateLimitIntervalMs: 8000, minFreeDiskBytes: 256 * 1024 * 1024,
  translationEnabled: true, translationProvider: 'mymemory', translationApiUrl: '', translationApiKey: '', translationEmail: '',
  translationTimeoutMs: 8000, translationSuggestLimit: 8,
  danbooruSearchEnabled: true, danbooruSearchUrl: 'https://sakizuki-danboorusearch.hf.space',
  danbooruSearchFallbackUrl: 'https://sakizuki-danboorusearchonline.ms.show', danbooruSearchTimeoutMs: 70000,
  danbooruSearchCacheMs: 12 * 3600000, danbooruSearchPointsPerMinute: 30, danbooruSearchDailyPoints: 15000,
  danbooruSearchApiKey: '', danbooruSearchClient: '', danbooruSearchSite: ''
});
