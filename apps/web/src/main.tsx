import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PreviewRoot from './previews/PreviewRoot.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreviewRoot />
  </StrictMode>,
)
