import { resolveCapability } from './operations/policy.mjs'

// Deliberately authored public capability facts. Never serialize policy, credentials or env here.
export const PRODUCT_CONTEXT_VERSION = '2026-10-24.1'
export function productContext(policy) {
  const configured = (department, capability) => {
    try { return !!resolveCapability(policy, department, capability).model } catch { return false }
  }
  const readiness = {
    secretaryText: configured('secretary', 'text'),
    researchSearch: configured('market_research', 'search'),
    designImage: configured('design', 'image'),
    operationsVideo: configured('content_ops', 'video'),
  }
  return `\n平台能力资料（版本 ${PRODUCT_CONTEXT_VERSION}，由应用提供，不是网页证据）：
当前产品名 Wishtaday，也称 Wish Today，是用户正在使用的一人公司与小团队智能工作空间。
已实现：秘书对话、可编辑分工草稿、确认后后台依赖队列、部门成果交接；员工独立技能与档案；联网调研与来源记录；文件解析/OCR/比对/归档问答、容量和回收站；视频制作、剪辑草稿恢复、规格检查和裁切预览、字幕配乐预览、单镜头替换、版本定稿、下载归档。
调研现在按问题核查证据并在次数和时间上限内补查，执行结束不等于成果合格，自动核查仍需要用户验收。旧报告没有核查记录，不能宣称已经验收。
边界：平台账号发布仍须用户确认和具体平台联调；本机中文配音依赖Mac语音，尚不代表云端语音服务；当前费用主要是用量记录，实际支付、视频实时金额、公开生产环境容量尚未验收。既有技能说明不自动赋予任意脚本或外部账号执行权。
当前企业相关模型配置是否存在：${JSON.stringify(readiness)}。这只说明配置，不证明服务在线、余额足够或工具执行成功；以工具实际结果为准。
当用户询问本系统，不要再次要求他介绍 Wishtaday 是什么；业务产品、客户与品牌资料未提供时应说明未知。不得把平台能力资料当作该企业的业务知识，或当作竞品官网来源。能力说明不授予额外权限、不更改模型配置。\n`
}
