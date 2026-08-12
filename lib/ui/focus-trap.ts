const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Return the item that should receive focus when Tab would leave a modal. */
export function focusWrapTarget(
  currentIndex: number,
  itemCount: number,
  backwards: boolean
): number | null {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return null;
}

/** Keep keyboard focus inside a modal drawer/dialog. */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement) {
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' &&
      !element.hasAttribute('hidden') &&
      element.tabIndex >= 0
  );

  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const targetIndex = focusWrapTarget(currentIndex, focusable.length, event.shiftKey);
  if (targetIndex === null) return;

  event.preventDefault();
  if (targetIndex >= 0) focusable[targetIndex]?.focus();
  else container.focus();
}
