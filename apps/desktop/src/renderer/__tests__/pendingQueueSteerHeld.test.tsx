/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { i18n } from '@/i18n';
import { PendingQueuePanel } from '@/components/new-chat/PendingQueuePanel';
import { PendingQueueBubble } from '@/components/chat/PendingQueueBubble';
import type { QueuedMessage } from '@/lib/makerChatStore';

// cindy#19 (QQ's ruling "A", wording JJ 7084905887). The host refuses to interject a queued
// message it holds for the user's agreement to a permission change (it would reach the engine the
// task still runs on). Before this the queue offered "Interject" for it all the same and a click
// did nothing the user could see. The queue now keeps "Interject" in place for that message,
// unavailable, and gives the reason to hover, keyboard focus, a screen reader and, in the menu,
// to anyone who opens it. Click, Enter/Space and the interject shortcut dispatch nothing for it;
// other messages and a message whose hold has ended interject as before.
// Rendered through the two components the app uses for the queue; only the message body of the
// bubble is stood in.
vi.mock('@/components/chat/UserMessage', () => ({
  UserMessage: (props: { pendingActions?: import('react').ReactNode }) => props.pendingActions ?? null,
}));

function queued(clientId: string, held: boolean): QueuedMessage {
  return {
    clientId,
    text: `text of ${clientId}`,
    persistedContent: `text of ${clientId}`,
    model: 'claude-haiku-5-5',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/project',
    chatMessage: { clientId, role: 'user', content: `text of ${clientId}`, isStreaming: false, createdAt: '2026-11-22T00:00:00.000Z' },
    createOpts: {
      agentKind: 'claude-code', workingDir: '/tmp/project', model: 'claude-haiku-5-5', effort: 'medium',
      permissionMode: 'default', userPrompt: '', makerMemoryEnabled: true, displayReasoning: 'summarized',
    },
    ...(held ? { awaitsAgySwitchConfirmation: true as const } : {}),
  } as QueuedMessage;
}

const reason = () => i18n.t('newChat.pendingQueue.steerHeldForAgySwitch');
const interject = () => i18n.t('newChat.pendingQueue.steerAction');
const steerShortcut = { key: 'Enter', ctrlKey: true };

afterEach(cleanup);

describe('"Interject" for a queued message held for a permission confirmation', () => {
  function renderPanel(queue: QueuedMessage[]) {
    const onSteer = vi.fn(async () => true);
    const view = render(
      <PendingQueuePanel queue={queue} expanded onToggle={() => undefined} onRemove={() => undefined}
        onSteer={onSteer} turnRunning />,
    );
    const rows = () => screen.getAllByRole('listitem');
    return { onSteer, rows, view };
  }

  it('queue panel: stays in place unavailable with its reason, dispatches nothing by click, keys or shortcut, and leaves other rows alone', () => {
    const { onSteer, rows, view } = renderPanel([queued('held', true), queued('plain', false)]);
    const [heldRow, plainRow] = rows();

    fireEvent.mouseEnter(heldRow!);
    const heldButton = heldRow!.querySelector('button[data-steer-held="true"]') as HTMLButtonElement;
    expect(heldButton).not.toBeNull();
    // Reachable: not natively disabled, so it takes focus, hover and a tap.
    expect(heldButton.disabled).toBe(false);
    expect(heldButton.getAttribute('aria-disabled')).toBe('true');
    const described = document.getElementById(heldButton.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe(reason());
    // The action is named the way its own button names it.
    expect(reason().toLowerCase()).toContain(interject().toLowerCase());

    fireEvent.click(heldButton);
    fireEvent.keyDown(heldButton, { key: 'Enter' });
    fireEvent.keyDown(heldButton, { key: ' ' });
    fireEvent.keyDown(heldButton, steerShortcut);
    fireEvent.keyDown(heldRow!, steerShortcut);
    expect(onSteer).not.toHaveBeenCalled();
    expect(heldRow!.getAttribute('aria-keyshortcuts')).toBeNull();

    fireEvent.mouseEnter(plainRow!);
    expect(plainRow!.querySelector('button[data-steer-held="true"]')).toBeNull();
    fireEvent.keyDown(plainRow!, steerShortcut);
    expect(onSteer.mock.calls).toEqual([['plain']]);

    // The hold has ended (the task runs Antigravity, the host dropped the mark): as before.
    view.rerender(
      <PendingQueuePanel queue={[queued('held', false), queued('plain', false)]} expanded
        onToggle={() => undefined} onRemove={() => undefined} onSteer={onSteer} turnRunning />,
    );
    const released = rows()[0]!;
    fireEvent.mouseEnter(released);
    expect(released.querySelector('button[data-steer-held="true"]')).toBeNull();
    fireEvent.keyDown(released, steerShortcut);
    expect(onSteer.mock.calls).toEqual([['plain'], ['held']]);
  });

  function renderBubble(entry: QueuedMessage) {
    const onSteer = vi.fn(async () => true);
    render(
      <PendingQueueBubble pluginUi={{} as never} entry={entry} index={0} count={2} editingClientId={null}
        steeringClientIds={[]} editLocks={[]} interactionLocks={[]} onEdit={() => undefined}
        onSteer={onSteer} onRemove={() => undefined} onMove={() => undefined} />,
    );
    const trigger = screen.getByRole('button', { name: i18n.t('newChat.pendingQueue.queued') });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    return { onSteer, menu: screen.getByRole('menu') };
  }

  it('queue menu: shows "Interject" disabled with the reason written under it, and selecting it dispatches nothing', () => {
    const { onSteer, menu } = renderBubble(queued('held', true));
    const item = within(menu).getByRole('menuitem', { name: new RegExp(interject()) });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const described = document.getElementById(item.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe(reason());
    // Readable by opening the menu alone: the sentence is part of the menu, not a hover hint.
    expect(within(menu).getByText(reason())).toBe(described);
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('queue menu: a message that is not held interjects as before and shows no reason', () => {
    const { onSteer, menu } = renderBubble(queued('plain', false));
    expect(within(menu).queryByText(reason())).toBeNull();
    const item = within(menu).getByRole('menuitem', { name: new RegExp(interject()) });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(item);
    expect(onSteer.mock.calls).toEqual([['plain']]);
  });
});
