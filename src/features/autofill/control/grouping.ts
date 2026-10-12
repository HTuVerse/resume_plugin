const SPECIFIC_GROUP = '[role="radiogroup"],.ant-radio-group,.el-radio-group,.arco-radio-group,.ant-checkbox-group,.el-checkbox-group,.arco-checkbox-group'
const GROUP_SELECTOR = `${SPECIFIC_GROUP},[role="group"],fieldset,[class*="form-item"],[class*="form_item"],[class*="field"]`

export function choiceGroupContainer(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>(GROUP_SELECTOR) || element.parentElement
}

export function sameChoiceGroupElements(left: HTMLInputElement, right: HTMLInputElement): boolean {
  if (left.type !== right.type) return false
  if (left.name && left.name === right.name && left.form === right.form) return true
  if (left.name || right.name) return false
  const labelledLeft = left.getAttribute('aria-labelledby')
  const labelledRight = right.getAttribute('aria-labelledby')
  if (labelledLeft || labelledRight) return labelledLeft === labelledRight
  const specificLeft = left.closest<HTMLElement>(SPECIFIC_GROUP)
  const specificRight = right.closest<HTMLElement>(SPECIFIC_GROUP)
  if (specificLeft || specificRight) return specificLeft === specificRight
  return choiceGroupContainer(left) != null && choiceGroupContainer(left) === choiceGroupContainer(right)
}

export function choiceGroupMode(container: HTMLElement, choices: HTMLElement[]): 'single-choice' | 'multi-choice' {
  if (container.getAttribute('role') === 'radiogroup' || choices.some(choice => choice.getAttribute('role') === 'radio')) return 'single-choice'
  if (container.getAttribute('aria-multiselectable') === 'true' || choices.some(choice => choice.getAttribute('role') === 'checkbox' || choice.getAttribute('role') === 'switch')) return 'multi-choice'
  return choices.some(choice => choice.hasAttribute('aria-pressed')) ? 'multi-choice' : 'single-choice'
}

