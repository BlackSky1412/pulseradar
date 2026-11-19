import React, { useState, useEffect } from 'react';
import { X, AlertCircle, KeyRound, Terminal } from 'lucide-react';
import {
  type WebhookServerItem,
  type WebhookFormat,
  WEBHOOK_FORMAT_LABELS,
  validateWebhookServerInput,
} from '../utils/scannerEngine';

interface WebhookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    id?: string;
    name: string;
    url: string;
    format: WebhookFormat;
    secretHeader: string;
    enabled: boolean;
  }) => Promise<void>;
  editingServer: WebhookServerItem | null;
}

export function WebhookModal({
  isOpen,
  onClose,
  onSave,
  editingServer,
}: WebhookModalProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<WebhookFormat>('json');
  const [secretHeader, setSecretHeader] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (editingServer) {
      setName(editingServer.name);
      setUrl(editingServer.url);
      setFormat(editingServer.format);
      setSecretHeader(editingServer.secretHeader);
      setEnabled(editingServer.enabled);
    } else {
      setName('');
      setUrl('/api/webhook-sandbox');
      setFormat('json');
      setSecretHeader(`whsec_${Math.random().toString(36).slice(2, 12)}`);
      setEnabled(true);
    }
    setErrorMsg(null);
  }, [editingServer, isOpen]);

  if (!isOpen) return null;

  const generateNewSecret = () => {
    const randomHex = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    setSecretHeader(`whsec_${randomHex}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const validation = validateWebhookServerInput({
      name,
      url,
      format,
      secretHeader,
    });

    if (!validation.valid) {
      setErrorMsg(validation.error || 'Dữ liệu cấu hình máy chủ không hợp lệ.');
      return;
    }

    setSubmitting(true);
    try {
      await onSave({
        id: editingServer?.id,
        name: name.trim(),
        url: url.trim(),
        format,
        secretHeader: secretHeader.trim(),
        enabled,
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể lưu cấu hình máy chủ.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-modal-title"
    >
      <div className="bg-slate-900 border-t sm:border border-slate-800 rounded-t-2xl sm:rounded-xl max-w-lg w-full p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto text-slate-100">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <h2 id="webhook-modal-title" className="text-base font-semibold text-slate-100">
            {editingServer ? 'Cập nhật máy chủ nhận thông báo' : 'Thêm máy chủ nhận Webhook mới'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại máy chủ"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg flex items-center gap-2 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label htmlFor="webhook-name-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Tên định danh máy chủ
            </label>
            <input
              id="webhook-name-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ví dụ: Máy chủ Production API hoặc Discord Alert Channel"
              maxLength={80}
              className="w-full min-h-[42px] px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label htmlFor="webhook-url-input" className="block text-xs font-semibold text-slate-300">
                Endpoint URL (Nhận HTTP POST)
              </label>
              <button
                type="button"
                onClick={() => setUrl('/api/webhook-sandbox')}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 whitespace-nowrap shrink-0"
              >
                <Terminal className="w-3 h-3" />
                Dùng Sandbox nội bộ (/api/webhook-sandbox)
              </button>
            </div>
            <input
              id="webhook-url-input"
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://your-server.com/webhooks/social-alerts"
              maxLength={500}
              className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
            />
            <p className="mt-1 text-xs text-slate-400">
              Nhập địa chỉ máy chủ của bạn (https://...) hoặc dùng /api/webhook-sandbox để kiểm thử trực tiếp trên giao diện.
            </p>
          </div>

          <div>
            <label htmlFor="webhook-format-select" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Cấu trúc Payload gửi về máy chủ
            </label>
            <select
              id="webhook-format-select"
              value={format}
              onChange={e => setFormat(e.target.value as WebhookFormat)}
              className="w-full min-h-[42px] px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-indigo-400"
            >
              {(Object.keys(WEBHOOK_FORMAT_LABELS) as WebhookFormat[]).map(f => (
                <option key={f} value={f}>
                  {WEBHOOK_FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label htmlFor="webhook-secret-input" className="block text-xs font-semibold text-slate-300">
                Khóa ký bảo mật HMAC-SHA256 (X-PulseBot-Signature)
              </label>
              <button
                type="button"
                onClick={generateNewSecret}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200 whitespace-nowrap shrink-0"
              >
                <KeyRound className="w-3 h-3" />
                Tạo khóa ngẫu nhiên
              </button>
            </div>
            <input
              id="webhook-secret-input"
              type="text"
              value={secretHeader}
              onChange={e => setSecretHeader(e.target.value)}
              placeholder="whsec_..."
              maxLength={128}
              className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
            />
            <p className="mt-1 text-xs text-slate-400">
              Bot sẽ dùng khóa này để tạo chữ ký sha256=... trong header X-PulseBot-Signature giúp máy chủ của bạn xác thực nguồn gửi.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[42px] px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {submitting ? 'Đang lưu...' : editingServer ? 'Lưu thay đổi' : 'Thêm máy chủ'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
