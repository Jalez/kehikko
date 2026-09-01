import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* react-grid-layout's own behaviour lives in these two stylesheets. What they
   look like on a black canvas is in `index.css`, after them, so that the
   overrides win without `!important`. */
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './index.css'

import { App } from './App.tsx'
import { announce } from './host/theme.ts'

/* Tell the desktop shell, if this page is inside one, what the blocking script
   in `index.html` decided the theme was. The shell keeps a copy so it can paint
   its window and its waiting room in the right colour on the next cold start —
   before any of this exists to be asked. `host/theme.ts` has why it cannot just
   read the cookie (different origin) and why this is a report rather than a
   second decision.

   Here rather than in a `useEffect` because it is not React's business and has
   nothing to do with rendering, and outside `apply()` because `apply()` only
   runs when somebody presses the toggle: a preference changed in a browser tab
   would otherwise be stale in the shell for a launch. In a browser this does
   nothing at all, silently. */
announce()

const root = document.getElementById('root')
if (!root) throw new Error('the page has no root to mount on')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
