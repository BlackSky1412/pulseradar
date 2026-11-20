import React, { useState, useEffect, useRef, useId } from 'react';
import { Info, X } from 'lucide-react';

export interface InfoPopoverProps {
  /** Custom trigger content; defaults to Info icon when omitted */
  trigger?: React.ReactNode;
  /** Accessible label for the trigger button */
  ariaLabel: string;
  /** Optional heading shown inside the opened panel */
  title?: string;
  /** Disclosure / tooltip body content */
  children: React.ReactNode;
  /** Additional classes for the trigger <button> (can add md:min-h-[...] for desktop density) */
  triggerClassName?: string;
  /** Additional classes for outer wrapper */
  className?: string;
  /** Additional classes for the panel */
  panelClassName?: string;
  /** Enforces min-w-[44px] in addition to min-h-[44px] on mobile */
  iconOnly?: boolean;
  /** 'popover' = fixed mobile sheet above bottom nav + desktop dropdown; 'inline' = in-flow block */
  placement?: 'popover' | 'inline';
  /** Desktop horizontal alignment when placement='popover' */
  align?: 'left' | 'right';
  /** Optional initial expanded state (enables SSR testing of expanded markup) */
  defaultOpen?: boolean;
}

export function InfoPopover({
  trigger,
  ariaLabel,
  title,
  children,
  triggerClassName = '',
  className = '',
  panelClassName = '',
  iconOnly = false,
  placement = 'popover',
  align = 'left',
  defaultOpen = false,
}: InfoPopoverProps) {
  const [isOpen, setIsOpen] = useState(Boolean(defaultOpen));
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  const panelPositionClasses =
    placement === 'inline'
      ? 'mt-2 w-full max-w-[calc(100vw-2rem)]'
      : `fixed inset-x-4 bottom-20 z-50 w-auto max-w-[calc(100vw-2rem)] md:inset-x-auto md:bottom-auto md:absolute md:top-full md:mt-2 md:w-80 md:max-w-[calc(100vw-2rem)] ${
          align === 'right' ? 'md:right-0' : 'md:left-0'
        }`;

  return (
    <div
      ref={containerRef}
      className={`${
        placement === 'inline'
          ? isOpen
            ? 'w-full max-w-full'
            : 'inline-block max-w-full'
          : 'relative inline-block max-w-full'
      } ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={ariaLabel}
        onClick={() => setIsOpen(prev => !prev)}
        className={`min-h-[44px] ${
          iconOnly ? 'min-w-[44px] justify-center' : ''
        } inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${triggerClassName}`}
      >
        {trigger ?? <Info className="w-4 h-4 shrink-0" />}
      </button>

      {isOpen && (
        <div
          id={panelId}
          role="region"
          aria-label={title || ariaLabel}
          className={`${panelPositionClasses} rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur-md p-3.5 text-xs text-slate-200 shadow-2xl ${panelClassName}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              {title && (
                <div className="font-semibold text-slate-100 leading-snug">{title}</div>
              )}
              <div className="text-slate-300 leading-relaxed break-words">{children}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Đóng thông tin"
              className="min-h-[44px] min-w-[44px] md:min-h-[28px] md:min-w-[28px] -mr-1.5 -mt-1.5 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
