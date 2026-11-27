/**
 * حرس نقطة الاستئناف (Durable Checkpoint Guard) — الخطوة الرابعة، قرار المستخدم 1.
 *
 * المشكلة المُثبتة في المكتبة: `pts` يتقدّم **قبل** تسليم التحديث للمعالج
 * (PtsWaiter.apply → onApplied ثم applyUpdate)، واللقطة الحيّة قد تتضمن الرسالة الجارية.
 * لذا حفظ اللقطة الحيّة يعني أن نقطة الاستئناف قد تتجاوز رسالة لم تُحفظ هويتها بعد ⇒ فقدان صامت.
 *
 * القاعدة: لا تُرقّى النقطة المحفوظة إلا عندما:
 *   1) لا توجد رسالة قيد المعالجة (inFlight = 0)،
 *   2) وليس هناك تثبيت بعد فشل غير محسوم،
 *   3) ولا يزال في المكتبة تحديث مُرسَل لم يبدأ معالجه بعد (`isBusy`).
 * إذا فشلت معالجة رسالة (فشل حفظ الهوية) تبقى النقطة **مثبَّتة** عند ما قبلها حتى إعادة التشغيل،
 * فتُعاد الرسالة من تيليجرام ولا تُفقد.
 *
 * ملاحظة (3) لازمة لأن مسار المكتبة غير متزامن: بين تقدّم `pts` وبدء معالجنا توجد انتظارات داخلية
 * (`builder.resolve`, `getMe`) قد يقع خلالها حفظ دوري، وحفظها يعني تجاوز رسالة لم تُعالج.
 *
 * الصنف نقي (بلا شبكة وبلا قاعدة بيانات) وقابل للاختبار مباشرة. لا يقرأ `readLive` عند الإنشاء
 * (كان ذلك يقرأ حقولاً لم تُهيَّأ بعد ويُسقط إنشاء العميل) بل عند أول لقطة فقط.
 */
export class CheckpointGuard<T> {
  private inFlight = 0;
  private durable: T | undefined;
  /** تثبيت النقطة بعد فشل غير محسوم؛ لا يُرفع إلا بإعادة تشغيل العملية (حالة جديدة). */
  private pinned = false;
  /** لأغراض المراقبة والاختبار. */
  private failures = 0;

  constructor(
    private readonly readLive: () => T | undefined,
    /** true عندما تكون المكتبة ما زالت تُفرّغ تحديثات لم تُسلَّم لمعالجنا بعد. */
    private readonly isBusy: () => boolean = () => false,
    /**
     * آخر نقطة استئناف موثوقة (المحفوظة في قاعدة البيانات عند الإقلاع). تُمنع النقطة المحفوظة من
     * النزول تحتها أبداً حتى لو حُفظت لقطة قبل أول حسم، فلا تُمحى نقطة الاستئناف بسبب تثبيت مبكر.
     */
    initial?: T,
  ) {
    this.durable = initial;
  }

  /** قبل بدء معالجة رسالة. */
  begin(): void {
    this.inFlight += 1;
  }

  /** هل يجوز الآن ترقية النقطة المحفوظة إلى اللقطة الحيّة؟ */
  private canAdvance(): boolean {
    if (this.inFlight !== 0 || this.pinned) return false;
    try {
      return !this.isBusy();
    } catch {
      // أي خلل في فحص الانشغال يُعامل كـ«منشغل»: التجمّد الآمن خير من تجاوز رسالة.
      return false;
    }
  }

  /**
   * تُرقّى النقطة المحفوظة إلى اللقطة الحيّة. لقطة غير مقروءة (undefined) لا تمسح نقطة محفوظة:
   * غياب القراءة ليس دليلاً على أن التقدّم صفر، ومحوه يعني البدء من الصفر بلا داعٍ.
   */
  private advanceFromLive(): void {
    const live = this.readLive();
    if (live !== undefined) this.durable = live;
  }

  /**
   * بعد انتهاء معالجة الرسالة.
   * @param ok true إذا حُسمت المعاملة بنجاح (التقاط/تكرار/استبعاد مُسجَّل). false عند فشل حفظ الهوية.
   */
  settle(ok: boolean): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (!ok) {
      // فشل غير محسوم: نثبّت النقطة عند ما قبل الرسالة (لا تخطّي صامت).
      this.pinned = true;
      this.failures += 1;
      return;
    }
    if (this.canAdvance()) this.advanceFromLive();
  }

  /**
   * اللقطة التي يجوز حفظها: إن كان هناك رسالة قيد المعالجة أو تثبيت بعد فشل أو تحديثات لم تُفرَّغ،
   * تُعاد آخر نقطة آمنة. عند الخمول التام تُرقّى إلى اللقطة الحيّة (آمنة لأن كل الرسائل السابقة محسومة).
   */
  snapshot(): T | undefined {
    if (this.canAdvance()) this.advanceFromLive();
    return this.durable;
  }

  get pending(): number {
    return this.inFlight;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  get failureCount(): number {
    return this.failures;
  }
}
