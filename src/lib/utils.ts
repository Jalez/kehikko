import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class helper, vendored where shadcn puts it. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
