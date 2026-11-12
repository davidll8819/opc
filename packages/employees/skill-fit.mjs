// Category names are the existing curated catalogue taxonomy. Recommendations never bind automatically.
const categories = {
  'xu-zhining': ['营销与运营', '浏览器与信息获取'],
  'cheng-zhiyao': ['开发、代理与工作流程', '后端、数据库与云服务'],
  'su-ying': ['营销与运营', '图像、视频与音频'],
  'shen-qinglan': ['浏览器与信息获取', '营销与运营'],
  marvis: ['办公与文档', '开发、代理与工作流程'],
  'code-agent': ['开发、代理与工作流程', '后端、数据库与云服务'],
  'file-agent': ['办公与文档'],
  'app-agent': ['营销与运营', '图像、视频与音频'],
  'review-agent': ['浏览器与信息获取', '营销与运营'],
  'data-agent': ['安全与隐私', '办公与文档'],
  'new-agent-7': ['界面、设计与动画', '图像、视频与音频'],
  'new-agent-8': ['营销与运营', '浏览器与信息获取'],
  'new-agent-9': ['办公与文档', '浏览器与信息获取'],
}
export function recommendedCategories(employeeId) {
  return [...(categories[employeeId] || [])]
}
export function skillFit(employeeId, category) {
  return recommendedCategories(employeeId).includes(category)
}
