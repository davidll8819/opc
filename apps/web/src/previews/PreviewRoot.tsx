import { lazy, Suspense } from 'react'
import App from '../saas/SaasApp'

const Proportions = lazy(() => import('./LiWanerProportions'))

export default function PreviewRoot() {
  // The isolated view never mounts the workspace or its API polling effects.
  if (new URLSearchParams(location.search).get('preview') === 'li-waner-proportions') {
    return <Suspense fallback={<p>正在加载比例对比…</p>}><Proportions /></Suspense>
  }
  return <App />
}
