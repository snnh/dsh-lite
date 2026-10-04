/**
 * General Settings row for the address this harness binds, plus the shell
 * overlay that reports a save after Settings closes.
 *
 * The row states the two addresses an operator has to tell apart — what the
 * running process bound and what the profile persists for the next start —
 * and offers the addresses worth stating: loopback, this machine's detected
 * LAN address when it has one, the wildcard, or one typed by hand. A save
 * writes the profile patch alone (the Host namespace's own scope), so the row
 * says "after restart" rather than pretending the running bind moved.
 *
 * Off the Host's own machine, and where no profile patch exists to write, the
 * row reports the posture's read-only reason instead of offering controls:
 * one address per machine, changed on the machine that runs the harness.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `shell.overlay` seat declaration owned by the layout plugin.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  NetworkHostController, NetworkNoticeKey, NetworkNoticeState, NetworkRowState,
} from './network-host.ts'
import css from './NetworkRow.module.css'

/** The loopback address the row always offers, the way back from an exposed bind. */
const LOOPBACK_HOST = '127.0.0.1'
/** The wildcard: every IPv4 interface this machine holds. */
const WILDCARD_HOST = '0.0.0.0'
/** Success outcome, announced with the design's check tone. */
const SAVED: NetworkNoticeKey = 'network.saved'

/** Registrant-owned dependencies of {@link NetworkRow}. */
export interface NetworkRowInjected {
  /** Whether this page runs on the machine that owns the bind address. */
  onHost: boolean
  /** Posture owner: the read on mount and the write behind Save. */
  controller: NetworkHostController
  hooks: {
    /** Controller snapshot bound by the UI renderer as useHost. */
    host: ObservableSnapshot<NetworkRowState>
  }
}

/** Full props of {@link NetworkRow}: item seat, localized copy, and the registrant's face. */
export type NetworkRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings.network'> & InjectFace<NetworkRowInjected>

/** Registrant-owned dependencies of {@link NetworkToast}. */
export interface NetworkToastInjected {
  hooks: {
    /** Notice snapshot bound by the UI renderer as useNotice. */
    notice: ObservableSnapshot<NetworkNoticeState>
  }
  /** Clear the announced outcome once the banner has faded. */
  dismiss(): void
}

/** Full props of {@link NetworkToast}: overlay seat, localized copy, and the registrant's face. */
export type NetworkToastProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.network'> & InjectFace<NetworkToastInjected>

/**
 * Whether one accepted bind host stays on this machine. The Host's grammar
 * admits IPv4 literals and `localhost`, so this is the whole loopback set the
 * row can be handed.
 * @param host - an accepted bind host.
 * @returns true when the address is not reachable off this machine.
 */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.')
}

/**
 * The surface every no-control state renders: the row's title and why this
 * page offers none.
 * @param props - resolved title and reason.
 * @returns the read-only row.
 */
function ReadOnlyRow({ title, note }: { title: string; note: string }): ReactNode {
  return <div className={css.row}>
    <div className={css.title}>{title}</div>
    <div className={css.description}>{note}</div>
  </div>
}

/**
 * Render the bind-address row.
 * @param props - item seat, localized copy, and the posture owner.
 * @returns the row: an editable surface, or the reason it is read-only here.
 */
export function NetworkRow({ onHost, controller, useHost, t }: NetworkRowProps): ReactNode {
  const state = useHost(snapshot => snapshot)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (onHost) void controller.load()
  }, [controller, onHost])
  if (!onHost) {
    return <ReadOnlyRow title={t('network.title')} note={t('network.readOnly.remoteHost')} />
  }
  const view = state.view
  if (view === null) {
    return <ReadOnlyRow
      title={t('network.title')}
      note={state.status === 'failed' ? t('network.loadFailed') : t('network.loading')}
    />
  }
  if (!view.rowFound) {
    return <ReadOnlyRow title={t('network.title')} note={t('network.readOnly.noRow')} />
  }
  if (!view.writable) {
    return <ReadOnlyRow title={t('network.title')} note={t('network.readOnly.noProfile')} />
  }
  // The stated address is what the next start resolves: the profile's line when
  // it has one, the running bind otherwise. The warning belongs to the address
  // an operator has committed to, not to whatever is being typed.
  const stated = view.persisted ?? view.bound
  // Loopback, the wildcard, and this machine's detected address: the three
  // worth one click, anything else typed.
  const candidates = [...new Set([
    LOOPBACK_HOST, WILDCARD_HOST, ...view.detected === undefined ? [] : [view.detected],
  ])]
  return <div className={css.row}>
    <div className={css.head}>
      <div>
        <div className={css.title}>{t('network.title')}</div>
        <div className={css.description}>{t('network.description')}</div>
      </div>
      <div className={css.phase}>
        {view.persisted === view.bound ? t('network.active') : t('network.restart')}
      </div>
    </div>
    <div className={css.facts}>
      <div className={css.fact}>
        <span className={css.factName}>{t('network.bound')}</span>
        <span className={css.factValue}>{view.bound ?? t('network.notSet')}</span>
      </div>
      <div className={css.fact}>
        <span className={css.factName}>{t('network.persisted')}</span>
        <span className={css.factValue}>{view.persisted ?? t('network.notSet')}</span>
      </div>
    </div>
    {stated === undefined || isLoopback(stated)
      ? null
      : <div className={css.warning}>{t('network.nonLoopbackWarning')}</div>}
    {stated === WILDCARD_HOST && <div className={css.warning}>{t('network.wildcardWarning')}</div>}
    {view.pinned === undefined
      ? null
      : <div className={css.warning}>{t('network.pinned', { host: view.pinned })}</div>}
    <div className={css.controls}>
      {candidates.map(candidate => <Button
        key={candidate}
        variant="outline"
        size="sm"
        onClick={() => { setDraft(candidate) }}
      >{candidate}</Button>)}
      <Input
        aria-label={t('network.custom')}
        placeholder={t('network.customPlaceholder')}
        value={draft}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={state.busy || draft.trim() === ''}
        onClick={() => { void controller.save(draft.trim()) }}
      >{t('network.save')}</Button>
    </div>
  </div>
}

/**
 * Keep a save outcome visible after Settings closes, from the same result the
 * row's own read produces.
 * @param props - overlay seat, localized copy, and the notice owner.
 * @returns the current banner, or nothing while no outcome is pending.
 */
export function NetworkToast({ useNotice, dismiss, t }: NetworkToastProps): ReactNode {
  const state = useNotice(snapshot => snapshot)
  if (state.notice === null) return null
  return <Toast
    key={state.sequence}
    text={t(state.notice)}
    onDone={dismiss}
    {...state.notice === SAVED ? { tone: 'success' as const } : {}}
  />
}
