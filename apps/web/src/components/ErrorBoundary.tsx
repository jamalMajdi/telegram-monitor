import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * حدود الأخطاء (P4-و): مكوّن واحد فاشل لا يُسقط التطبيق كله.
 *
 * قرارات:
 * - **لا تفاصيل تقنية للمستخدم**: لا stack ولا رسالة استثناء خام في الشاشة (قد تحمل مساراً أو
 *   بيانات)، بل رسالة عربية ثابتة + إجراءان: إعادة المحاولة (إعادة تركيب الشجرة) والعودة للوحة.
 * - **إعادة الضبط عند تغيير المسار**: `resetKey` تتغيّر مع المسار فتُفرَّغ الحالة تلقائياً؛
 *   بلا ذلك يبقى المستخدم محبوساً في شاشة خطأ صفحةٍ أخرى.
 * - **التسجيل في وحدة التحكم فقط**: `console.error` بلا أي محتوى مستخدم — لأغراض التطوير.
 */
interface Props {
  children: ReactNode;
  /** نص العنوان داخل البطاقة (افتراضي عربي عام). */
  title?: string;
  /** قيمة تتغيّر فتُعيد تصفير الحالة (عادةً مسار الصفحة الحالي). */
  resetKey?: string;
  /** إخفاء زر «لوحة التحكم» في الحدود العامة (خارج التطبيق المسجّل). */
  hideHome?: boolean;
}

interface State {
  hasError: boolean;
  /** رمز مرجعي قصير يعرض للمستخدم ويُسهّل ربط الشكوى بالسجل — لا يحمل أي محتوى. */
  reference: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, reference: null };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true, reference: `E-${Date.now().toString(36).toUpperCase()}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // بلا بيانات مستخدم: نوع الخطأ وأول إطار من الشجرة فقط.
    console.error('[ui] خطأ في مكوّن', error.name, info.componentStack?.split('\n')[1]?.trim() ?? '');
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  private reset = (): void => {
    this.setState({ hasError: false, reference: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="card space-y-3 border-rose-200 bg-rose-50/40" role="alert">
        <h2 className="text-base font-semibold text-rose-800">
          {this.props.title ?? 'تعذّر عرض هذا الجزء من الصفحة'}
        </h2>
        <p className="text-sm text-slate-700">
          حدث خطأ غير متوقع أثناء العرض. بقية التطبيق يعمل، ويمكنك إعادة المحاولة أو متابعة العمل من لوحة
          التحكم. بياناتك لم تُفقد.
        </p>
        {this.state.reference ? (
          <p className="text-xs text-slate-500" dir="ltr">
            {this.state.reference}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={this.reset}>
            إعادة المحاولة
          </button>
          {this.props.hideHome ? null : (
            <a className="btn-secondary" href="/">
              العودة إلى لوحة التحكم
            </a>
          )}
        </div>
      </div>
    );
  }
}
