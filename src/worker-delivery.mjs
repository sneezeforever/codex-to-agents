// Shared delivery convention for the three execution ends (DSH, Hermes, Qoder).
// This module is copied verbatim into the self-contained DSH runtime snapshot,
// so it must stay dependency-free: builtins only, and no relative repository
// imports.
export const DELIVERY_GUIDANCE = [
  '交付要求（执行端自报，简洁即可）：',
  '1. 最后回复先明确结果：已完成，或阻塞（阻塞要写清卡点与已尝试的动作）。',
  '2. 列出修改了哪些文件，并注明每个文件改了什么。',
  '3. 用几句话概括实现摘要。',
  '4. 给出实际执行的验证命令，以及退出码或通过数；没跑就明确写“未验证”。',
  '5. 列出未验证事项与残余风险。',
  '6. 列出需要 SOL 决策的事项；没有就写“无”。',
  '7. 用户或原任务若指定了输出格式（例如 JSON、补丁、固定标记）或验收方式，以原任务为准：本约定只补充交付信息，须在指定格式内容纳这些信息，不要追加另一种格式或改写原格式。',
  '约束：不贴完整源码；不顺手扩大 scope（发现无关问题只报告不修改）；已有测试证据且没有新变更或疑点时，不反复跑全仓测试。',
  '以上是执行端自报信息，不得伪造结构化测试事实，也不得声称已做独立验收。',
].join('\n');

export function withDeliveryGuidance(kind, action, text) {
  if (typeof text !== 'string') return text;
  const eligible = kind === 'work_submit'
    || (kind === 'work_update' && (action === 'append' || action === 'interrupt'));
  return eligible ? `${text}\n\n${DELIVERY_GUIDANCE}` : text;
}
