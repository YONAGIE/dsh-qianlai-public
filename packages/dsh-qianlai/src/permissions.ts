export interface PermissionPresets {
  current(session: { readonly id: string }): string
  resolve(name: string): { readonly sandbox: string; readonly approval: string }
}

/** Use the live host's effective preset and bundle, never a tool argument. */
export function hasFullAccess(session: { readonly id: string }, presets?: PermissionPresets): boolean {
  try {
    if (!presets || presets.current(session) !== 'danger-full-access') return false
    const { sandbox, approval } = presets.resolve('danger-full-access')
    return sandbox === 'danger-full-access' && approval === 'never'
  } catch {
    return false
  }
}
