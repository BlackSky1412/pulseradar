import { fetchWithTimeout, safeJsonParse } from '../../liveCheckers/httpClient';
import { extractXUsername } from '../../liveCheckers/xChecker';

export { extractXUsername };

export const X_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
export const X_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const X_GUEST_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours

export const X_USER_BY_SCREEN_NAME_QUERY_ID = 'qW5u-DAuXpMEG0zA1F7UGQ';
export const X_USER_TWEETS_QUERY_ID = 'V7H0Ap3_Hh2FyS75OCDO3Q';

export const X_USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

export const X_USER_TWEETS_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_api_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

let guestTokenCache: { token: string; expiresAt: number } | null = null;

export function clearXGuestTokenCache(): void {
  guestTokenCache = null;
}

export function attachXAuthHeaders(
  headers: Record<string, string>,
  xCookie = '',
  guestToken = ''
): void {
  const trimmedCookie = typeof xCookie === 'string' ? xCookie.trim() : '';
  if (trimmedCookie) {
    headers.Cookie = trimmedCookie;
    const ct0Match = trimmedCookie.match(/ct0=([a-zA-Z0-9_-]+)/);
    if (ct0Match?.[1]) {
      headers['x-csrf-token'] = ct0Match[1];
    }
    headers['x-twitter-auth-type'] = 'OAuth2Session';
    headers['x-twitter-active-user'] = 'yes';
    headers['x-twitter-client-language'] = 'en';
    return;
  }

  if (guestToken) {
    headers['x-guest-token'] = guestToken;
    headers['x-twitter-active-user'] = 'yes';
    headers['x-twitter-client-language'] = 'en';
  }
}

export async function getOrRefreshXGuestToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && guestTokenCache && now < guestTokenCache.expiresAt) {
    return guestTokenCache.token;
  }

  try {
    const resp = await fetchWithTimeout('https://api.twitter.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: {
        Authorization: X_BEARER_TOKEN,
        'User-Agent': X_USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: '',
      timeoutMs: 10000,
    });
    if (resp.ok && resp.text) {
      const json = safeJsonParse<Record<string, unknown>>(resp.text);
      const token = typeof json?.guest_token === 'string' ? json.guest_token.trim() : '';
      if (token) {
        guestTokenCache = { token, expiresAt: now + X_GUEST_TOKEN_LIFETIME_MS };
        return token;
      }
    }
  } catch {
    // ignore and return cached if any
  }

  return guestTokenCache?.token || '';
}
