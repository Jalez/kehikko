/**
 * The grid's own collision and compaction rules, which `arrange.ts` runs so an agent's resize or
 * move lands where a person's drag would. The package ships these untyped; this is the part used.
 */
declare module 'react-grid-layout/build/utils' {
  export interface RglItem {
    i: string
    x: number
    y: number
    w: number
    h: number
    static?: boolean
    moved?: boolean
  }
  export function cloneLayout<T extends RglItem>(layout: readonly T[]): T[]
  export function compact<T extends RglItem>(layout: readonly T[], compactType: 'vertical' | 'horizontal' | null, cols: number, allowOverlap?: boolean): T[]
  export function moveElement<T extends RglItem>(
    layout: T[],
    l: T,
    x: number | null | undefined,
    y: number | null | undefined,
    isUserAction: boolean,
    preventCollision: boolean,
    compactType: 'vertical' | 'horizontal' | null,
    cols: number,
    allowOverlap?: boolean,
  ): T[]
}
