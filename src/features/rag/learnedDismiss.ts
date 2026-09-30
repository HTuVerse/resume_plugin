/** 本次填写会话里，用户放弃过的「字段 + 页面值」。改成新内容后键不同，可以再次列入。 */
export function learnedDismissKey(fieldId: string, pageValue: string): string {
  return `${fieldId}\0${pageValue.trim()}`
}

/** 同一字段、同一页面值已放弃时不再列入待确认。空值不算放弃。 */
export function isLearnedDismissed(dismissed: ReadonlySet<string>, fieldId: string, pageValue: string): boolean {
  const value = pageValue.trim()
  if (!fieldId || !value) return false
  return dismissed.has(learnedDismissKey(fieldId, value))
}
