export function getTruncatedLabelText(
  label: Pick<HTMLElement, 'textContent' | 'scrollWidth' | 'clientWidth'>,
): string | null {
  if (label.scrollWidth <= label.clientWidth) return null;
  return label.textContent?.trim() || null;
}
