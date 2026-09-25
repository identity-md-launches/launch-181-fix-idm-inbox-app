import { useEffect, useRef, type RefObject } from 'react';

export function useDialogFocus(
  dialog: RefObject<HTMLDivElement | null>,
  open: boolean,
  close: () => void,
  opener?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const previous = opener?.current ?? document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const buttons = () => [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .filter((button) => !button.disabled);
    buttons()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const list = buttons();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(index + (event.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [dialog, open, opener]);
}
