/** أخطاء HTTP موحّدة برسائل عربية آمنة (لا تكشف تفاصيل داخلية). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = 'يجب تسجيل الدخول للمتابعة.') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'لا تملك صلاحية لهذا الإجراء.') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (message = 'العنصر المطلوب غير موجود.') =>
  new ApiError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const tooManyRequests = (message: string, retryAfterSeconds?: number) => {
  const err = new ApiError(429, 'rate_limited', message);
  return Object.assign(err, { retryAfterSeconds });
};
export const accountLocked = (message: string, retryAfterSeconds?: number) => {
  const err = new ApiError(423, 'account_locked', message);
  return Object.assign(err, { retryAfterSeconds });
};
