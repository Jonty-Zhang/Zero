import { useEffect, useRef } from 'react';

export function useDialog(onClose: () => void, busy = false) {
  const ref = useRef<HTMLElement>(null);
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    if (!element) return;
    const controls = () => Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')).filter(node => {
      if (node.closest('fieldset:disabled') || node.getAttribute('tabindex') === '-1' || node.getAttribute('type') === 'hidden') return false;
      if (node.tagName === 'SUMMARY' && (node.parentElement?.tagName !== 'DETAILS' || Array.from(node.parentElement.children).find(child => child.tagName === 'SUMMARY') !== node)) return false;
      for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || ancestor.hasAttribute('inert') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) {
          const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
          if (!summary?.contains(node)) return false;
        }
        if (ancestor === element) break;
      }
      return true;
    });
    (controls()[0] ?? element).focus();
    const onKey = (event: KeyboardEvent) => {
      // Escape can dismiss the IME candidate window rather than the dialog.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!state.current.busy) state.current.onClose(); }
      if (event.key === 'Tab') {
        const items = controls(); const first = items[0]; const last = items.at(-1);
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) (controls()[0] ?? element).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    // Disabling the focused submit control can move native browser focus to BODY.
    if (busy) ref.current?.focus();
  }, [busy]);
  return ref;
}
