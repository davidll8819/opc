import { Component, type ReactNode } from 'react'

export class WorkspaceErrorBoundary extends Component<
  { children: ReactNode; tenantId: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section className="welcome" role="alert">
        <h1>这个页面暂时无法显示</h1>
        <p>请返回秘书页面后重试。如果仍然出现问题，请告诉我们刚才打开的页面。</p>
        <button onClick={() => {
          location.hash = new URLSearchParams({ workspace: this.props.tenantId, view: 'secretary' }).toString()
          location.reload()
        }}>返回私人秘书</button>
      </section>
    )
  }
}
