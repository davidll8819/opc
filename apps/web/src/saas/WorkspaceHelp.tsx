export function WorkspaceHelp({ onStart, onTasks, onUsage }: { onStart: () => void; onTasks: () => void; onUsage: () => void }) {
  return <section className="onboarding-page"><h1>使用帮助</h1>
    <h2>从需求到成果</h2><ol><li>直接告诉私人秘书你想完成什么；有文件时在对话中添加附件。</li><li>秘书整理任务分工，必要时向你补充提问；确认后开始后台执行。</li><li>在“任务成果”查看进度、待确认事项与负责人。打开任务后可收藏地址，刷新仍可返回。</li><li>查看成果、依据与缺口，按实际满意程度验收。归档不等于验收；对外发布单独确认。</li></ol>
    <h2>失败或长时间等待</h2><p>先打开原任务的执行记录。遇到“结果未知”先核对服务商账单；不要反复新建同一任务。恢复入口会说明可能再次计费，确认后才继续。</p>
    <h2>资料和权限</h2><p>当前任务与资料按工作空间及用户隔离。需求单中的项目名称仅用于分组，不会自动共享文件或改变成员权限。只能附带你有权使用的资料；公开链接不得携带密钥。</p>
    <h2>需要帮助时提供什么</h2><p>复制任务链接，说明操作步骤、发生时间和页面错误提示。不要发送 API Key、密码、完整请求配置或私密原文。目前没有内置客服工单系统。</p>
    <button onClick={onStart}>找私人秘书安排工作</button> <button onClick={onTasks}>打开待我处理</button> <button onClick={onUsage}>核对用量</button>
  </section>
}
