import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* react-grid-layout's own behaviour lives in these two stylesheets. What they
   look like on a black canvas is in `index.css`, after them, so that the
   overrides win without `!important`. */
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './index.css'

import { App } from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('the page has no root to mount on')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
