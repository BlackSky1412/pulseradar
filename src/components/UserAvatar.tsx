import React, { useEffect, useState } from 'react';
import { extractTargetUsername } from '../utils/scannerEngine';

export interface UserAvatarProps {
  target: string;
  username?: string;
  nickname?: string;
  platform?: string;
  avatarUrl?: string | null;
  isLive?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  showPlatformBadge?: boolean;
  className?: string;
}

const GRADIENTS = [
  'from-violet-600 to-indigo-700',
  'from-emerald-500 to-teal-700',
  'from-rose-500 to-pink-700',
  'from-amber-500 to-orange-700',
  'from-cyan-500 to-blue-700',
  'from-fuchsia-600 to-purple-800',
  'from-red-600 to-rose-800',
  'from-sky-500 to-indigo-600',
  'from-teal-600 to-emerald-800',
  'from-blue-600 to-violet-800',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function extractDisplayUsername(rawTarget: string, explicitUsername?: string): string {
  if (explicitUsername && explicitUsername.trim()) {
    return explicitUsername.trim().replace(/^@+/, '');
  }
  const trimmed = rawTarget.trim();
  if (!trimmed) return 'User';

  const extracted = extractTargetUsername(trimmed);
  if (extracted) return extracted;

  return trimmed.replace(/^@+/, '').split(/[/?#]/)[0] || trimmed;
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  target,
  username: explicitUsername,
  nickname,
  platform = 'tiktok',
  avatarUrl,
  isLive = false,
  size = 'md',
  showPlatformBadge = true,
  className = '',
}) => {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const cleanName = extractDisplayUsername(target, explicitUsername);
  const initial = (cleanName.charAt(0) || 'U').toUpperCase();

  const colorIndex = hashString(cleanName) % GRADIENTS.length;
  const gradientClass = GRADIENTS[colorIndex];

  // Derive candidate image URL
  const normPlatform = platform.toLowerCase();
  const candidateUrl =
    avatarUrl ||
    (normPlatform === 'tiktok'
      ? `https://unavatar.io/tiktok/${encodeURIComponent(cleanName)}`
      : normPlatform === 'instagram'
      ? `https://unavatar.io/instagram/${encodeURIComponent(cleanName)}`
      : normPlatform === 'x' || normPlatform === 'twitter'
      ? `https://unavatar.io/x/${encodeURIComponent(cleanName)}`
      : normPlatform === 'facebook'
      ? `https://unavatar.io/facebook/${encodeURIComponent(cleanName)}`
      : `https://unavatar.io/${encodeURIComponent(cleanName)}`);

  useEffect(() => {
    setImgError(false);
    setImgLoaded(false);
  }, [candidateUrl]);

  const titleLabel =
    nickname && nickname.trim() && nickname.trim() !== cleanName
      ? `${nickname.trim()} (@${cleanName}) (${platform.toUpperCase()})`
      : `${cleanName} (${platform.toUpperCase()})`;

  const sizeClasses = {
    xs: 'w-6 h-6 text-[10px]',
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
    xl: 'w-16 h-16 text-xl',
  }[size];

  const badgeSizeClasses = {
    xs: 'w-2.5 h-2.5 -bottom-0.5 -right-0.5',
    sm: 'w-3 h-3 -bottom-0.5 -right-0.5',
    md: 'w-3.5 h-3.5 -bottom-0.5 -right-0.5',
    lg: 'w-4 h-4 -bottom-1 -right-1',
    xl: 'w-5 h-5 -bottom-1 -right-1',
  }[size];

  const liveDotClasses = {
    xs: 'w-2 h-2 -top-0.5 -right-0.5',
    sm: 'w-2.5 h-2.5 -top-0.5 -right-0.5',
    md: 'w-3 h-3 -top-0.5 -right-0.5',
    lg: 'w-3.5 h-3.5 -top-1 -right-1',
    xl: 'w-4 h-4 -top-1 -right-1',
  }[size];

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 select-none ${
        isLive ? 'ring-2 ring-rose-500 ring-offset-2 ring-offset-slate-950 rounded-full' : ''
      } ${className}`}
      aria-label={`${cleanName} (${platform.toUpperCase()})`}
      title={titleLabel}
    >
      {/* Base Avatar Container */}
      <div
        className={`rounded-full overflow-hidden flex items-center justify-center font-bold font-mono text-white shadow-inner bg-gradient-to-br ${gradientClass} ${sizeClasses}`}
      >
        {/* Real Avatar Image with Graceful Fallback */}
        {!imgError && candidateUrl && (
          <img
            src={candidateUrl}
            alt={cleanName}
            referrerPolicy="no-referrer"
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover rounded-full transition-opacity duration-300 ${
              imgLoaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* Fallback Initial / Monogram */}
        {(!imgLoaded || imgError || !candidateUrl) && (
          <span className="uppercase tracking-tight leading-none drop-shadow-sm">{initial}</span>
        )}
      </div>

      {/* Live Blinking Dot / Pulse Indicator */}
      {isLive && (
        <span
          className={`absolute ${liveDotClasses} flex items-center justify-center z-10`}
          aria-hidden="true"
          title="ĐANG LIVE"
        >
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-full w-full bg-rose-500 border border-slate-950" />
        </span>
      )}

      {/* Platform Logo Badge */}
      {showPlatformBadge && (
        <span
          className={`absolute ${badgeSizeClasses} rounded-full flex items-center justify-center shadow-md border border-slate-950 z-10 ${
            normPlatform === 'tiktok'
              ? 'bg-black text-rose-400'
              : normPlatform === 'instagram'
              ? 'bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 text-white'
              : normPlatform === 'facebook'
              ? 'bg-[#1877F2] text-white'
              : 'bg-black text-white border-slate-700'
          }`}
          aria-hidden="true"
          title={`Nền tảng: ${normPlatform.toUpperCase()}`}
        >
          {normPlatform === 'tiktok' && (
            <svg className="w-[65%] h-[65%]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 3 15.68a6.34 6.34 0 0 0 6.34 6.32 6.34 6.34 0 0 0 6.34-6.32V8.71a8.23 8.23 0 0 0 4.91 1.6V6.86a4.82 4.82 0 0 1-1-.17z" />
            </svg>
          )}
          {normPlatform === 'instagram' && (
            <svg className="w-[65%] h-[65%]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
              <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
            </svg>
          )}
          {normPlatform === 'facebook' && (
            <svg className="w-[65%] h-[65%]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
            </svg>
          )}
          {(normPlatform === 'x' || normPlatform === 'twitter') && (
            <svg className="w-[60%] h-[60%]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          )}
        </span>
      )}
    </div>
  );
};
