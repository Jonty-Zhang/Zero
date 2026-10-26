import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDialog } from './dialog';

function DraftDialog({ busy = false, onClose }: { busy?: boolean; onClose: () => void }) {
  const ref = useDialog(onClose, busy);
  const [draft, setDraft] = useState('');
  return <section role="dialog" aria-label="项目草稿" ref={ref} tabIndex={-1}>
    <fieldset disabled={busy}>
      <button type="button" onClick={onClose}>关闭</button>
      <label>项目要求<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button type="button">提交</button>
    </fieldset>
  </section>;
}

function Workspace({ busy = false, onClose = () => {} }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>新建项目</button><button type="button">其他页面</button>
    {open && <DraftDialog busy={busy} onClose={() => { onClose(); setOpen(false); }} />}
  </>;
}

function openDraft(options: Parameters<typeof Workspace>[0] = {}) {
  const view = render(<Workspace {...options} />);
  const opener = screen.getByRole('button', { name: '新建项目' });
  opener.focus(); fireEvent.click(opener);
  const field = screen.getByLabelText('项目要求') as HTMLTextAreaElement;
  field.focus(); fireEvent.change(field, { target: { value: '正在输入的重要项目要求' } });
  return { ...view, opener, field };
}

function press(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  fireEvent(target, event);
  return event;
}

afterEach(cleanup);

function ChangingWorkspace({ openerState = 'ready', autoOpen = false }: { openerState?: 'ready' | 'removed' | 'disabled'; autoOpen?: boolean }) {
  const [open, setOpen] = useState(autoOpen);
  return <><main tabIndex={-1} aria-label="项目工作区">
    {openerState !== 'removed' && <button type="button" disabled={openerState === 'disabled'} onClick={() => setOpen(true)}>查看项目</button>}
    <button type="button">下一个项目</button>
  </main>{open && <DraftDialog onClose={() => setOpen(false)} />}</>;
}

describe('dialog return focus when the workspace changes', () => {
  it.each(['removed', 'disabled'] as const)('returns to the main workspace when the opener becomes %s', openerState => {
    const view = render(<ChangingWorkspace />);
    const opener = screen.getByRole('button', { name: '查看项目' });
    opener.focus(); fireEvent.click(opener);
    view.rerender(<ChangingWorkspace openerState={openerState} />);
    press(screen.getByRole('dialog'), 'Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('returns to the main workspace when a dialog opened without a focused control', () => {
    render(<ChangingWorkspace autoOpen />);
    press(screen.getByRole('dialog'), 'Escape');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

describe('dialog keyboard handling during IME composition', () => {
  it.each([
    ['isComposing', { isComposing: true, keyCode: 27 }],
    ['legacy 229', { isComposing: false, keyCode: 229 }],
  ] as const)('preserves the dialog and draft when IME Escape reports %s', (_name, keyboard) => {
    const onClose = vi.fn();
    const { field, opener } = openDraft({ onClose });
    fireEvent.compositionStart(field);
    const escape = press(field, 'Escape', keyboard);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '项目草稿' })).toBeTruthy();
    expect(field.value).toBe('正在输入的重要项目要求');
    expect(document.activeElement).toBe(field);
    expect(escape.defaultPrevented).toBe(false);
    fireEvent.compositionEnd(field);
    const normalEscape = press(field, 'Escape');
    expect(normalEscape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on an ordinary Escape and restores focus to the opener', () => {
    const onClose = vi.fn(); const { field, opener } = openDraft({ onClose });
    expect(press(field, 'Escape').defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('still blocks Escape while busy and traps focus when all controls are disabled', () => {
    const onClose = vi.fn(); const view = openDraft({ onClose });
    view.rerender(<Workspace busy onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(press(dialog, 'Escape').defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    dialog.blur();
    expect(press(document.body, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(view.field.value).toBe('正在输入的重要项目要求');
    view.rerender(<Workspace busy={false} onClose={onClose} />);
    press(dialog, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(view.opener);
  });

  it('retains the ordinary forward and reverse focus loop and background focus containment', () => {
    openDraft();
    const first = screen.getByRole('button', { name: '关闭' });
    const last = screen.getByRole('button', { name: '提交' });
    last.focus(); expect(press(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press(first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    screen.getByRole('button', { name: '其他页面' }).focus();
    expect(document.activeElement).toBe(first);
  });
});
