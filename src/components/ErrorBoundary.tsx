import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'Đã xảy ra lỗi không xác định.',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught Application Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let parsedDetails: Record<string, unknown> | null = null;
      try {
        parsedDetails = JSON.parse(this.state.errorMessage);
      } catch {
        parsedDetails = null;
      }

      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 sm:p-6">
          <div className="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-3 text-rose-400">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h1 className="text-base sm:text-lg font-semibold text-slate-100">
                Gián đoạn kết nối dữ liệu hoặc quyền truy cập
              </h1>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">
              Hệ thống phát hiện lỗi khi đồng bộ dữ liệu. Vui lòng kiểm tra cấu hình hoặc tải lại trang.
            </p>
            {parsedDetails ? (
              <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto">
                {JSON.stringify(parsedDetails, null, 2)}
              </pre>
            ) : (
              <p className="text-xs font-mono text-slate-300 bg-slate-950 border border-slate-800 p-3 rounded-lg break-words">
                {this.state.errorMessage}
              </p>
            )}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Tải lại ứng dụng
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
