export type Diagram = {
  id: string
  title: string
  /** Kept so a PNG the cache lost can be drawn again. */
  mermaid: string
  file: string
  width: number
  height: number
  /** When it was last shown, for evicting the least recently used. */
  opened: number
}

/** Zoom, and the view's center as a fraction of the diagram's size. */
export type View = {
  zoom: number
  x: number
  y: number
}

declare module 'claude-code' {
  interface PluginState {
    'diagram-pane': {
      diagrams: Shaped<Diagram[]>
      current: number
      view: View
      logOpen: boolean
      redraws: number
    }
  }
}
