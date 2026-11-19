import React, { useState } from 'react';
import { X, Copy, Check, ExternalLink, Send } from 'lucide-react';
import { type AlertDetectionItem, PLATFORM_LABELS } from '../utils/scannerEngine';

interface PayloadInspectorModalProps {
  alertItem: AlertDetectionItem | null;
  onClose: () => void;
  onRetryWebhook: (alertItem: AlertDetectionItem) => Promise<void>;
}

export function PayloadInspectorModal({
  alertItem,
  onClose,
  onRetryWebhook,
}: PayloadInspectorModalProps) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (!alertItem) return null;

  const copyPayload = async () => {
    try {
      await navigator.clipboard.writeText(alertItem.payloadJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors in headless mode
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetryWebhook(alertItem);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inspector-modal-title"
    >
      <div className="bg-slate-900 border-t sm:border border-slate-800 rounded-t-2xl sm:rounded-xl max-w-2xl w-full p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto text-slate-100">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 gap-3">
          <div>
            <h2 id="inspector-modal-title" className="text-base font-semibold text-slate-100">
              Chi tiết phát hiện & Webhook Payload
            </h2>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
              Từ khóa: {alertItem.keyword} · Nguồn: {PLATFORM_LABELS[alertItem.platform]} · HTTP {alertItem.httpStatusCode} ({alertItem.latencyMs}ms)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng chi tiết payload"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          <div className="p-4 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>Tác giả: @{alertItem.author}</span>
              <a
                href={alertItem.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium"
              >
                Mở bài viết gốc
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <h3 className="font-semibold text-slate-100">{alertItem.title}</h3>
            <p className="text-xs text-slate-300 leading-relaxed">{alertItem.contentSnippet}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-3 border-y border-slate-800 text-xs">
            <div>
              <span className="text-slate-400 block">Máy chủ đích</span>
              <span className="font-medium text-slate-100">{alertItem.webhookServerName}</span>
            </div>
            <div>
              <span className="text-slate-400 block">Trạng thái HTTP</span>
              <span className="font-mono font-medium text-emerald-400 tabular-nums">
                {alertItem.webhookStatus === 'delivered' ? 'Đã gửi (200 OK)' : `Lỗi (${alertItem.httpStatusCode})`}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Độ trễ phản hồi</span>
              <span className="font-mono font-medium text-slate-100 tabular-nums">
                {alertItem.latencyMs} ms
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-slate-300">
                HTTP POST Body đã gửi về máy chủ
              </span>
              <button
                type="button"
                onClick={copyPayload}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-100 whitespace-nowrap shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Đã sao chép JSON' : 'Sao chép JSON'}
              </button>
            </div>
            <pre className="p-4 bg-slate-950 border border-slate-800 text-slate-200 rounded-lg text-xs font-mono overflow-x-auto max-h-64 leading-relaxed">
              {alertItem.payloadJson}
            </pre>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-800">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="min-h-[42px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            {retrying ? 'Đang gửi lại...' : 'Gửi lại thông báo về máy chủ'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
