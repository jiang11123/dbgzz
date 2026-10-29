// 制作计划：助手自己维护、用户能看到的步骤清单，存在会话状态文档里。
// 这里只放纯逻辑（校验、渲染、续跑判断）；落盘和工具装配在会话宿主里。

export const PLAN_STATUSES = ['todo', 'doing', 'done', 'needs_user', 'blocked'];
export const PLAN_MAX_ITEMS = 12;
const LABEL = { todo: '待做', doing: '进行中', done: '完成', needs_user: '等你确认', blocked: '卡住了' };

export const PLAN_UPDATE_PARAMETERS = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: '这件事最终要做成什么，一句话。省略则保持原样。' },
    items: {
      type: 'array', maxItems: PLAN_MAX_ITEMS,
      description: '完整的步骤清单（整体替换）。按执行顺序排列，每步是用户能看懂的一件事。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '步骤的稳定编号，如 s1。更新状态时沿用原编号。' },
          title: { type: 'string', description: '这一步做什么，例如“角色设定”“镜 1–4 首帧”。' },
          status: { type: 'string', enum: PLAN_STATUSES, description: 'todo 待做 / doing 进行中 / done 完成 / needs_user 需要用户确认或回答后才能继续 / blocked 出错无法继续。' },
          note: { type: 'string', description: '可选：简短备注，如等待什么、为什么卡住。' },
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const fail = (reason) => Object.assign(new Error(reason), { reason });
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

export const emptyPlan = () => ({ goal: '', items: [], updatedAt: '' });

// 校验并合并：整体替换步骤清单；goal 省略则保留。
export function applyPlanUpdate(current, args, now = new Date().toISOString()) {
  const base = current && typeof current === 'object' ? current : emptyPlan();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid_plan: 参数必须是对象');
  const next = { goal: base.goal || '', items: base.items || [], updatedAt: now };
  if (args.goal !== undefined) {
    if (typeof args.goal !== 'string') throw fail('invalid_plan: goal 必须是文字');
    next.goal = clip(args.goal, 200);
  }
  if (args.items !== undefined) {
    if (!Array.isArray(args.items) || args.items.length > PLAN_MAX_ITEMS) throw fail(`invalid_plan: 步骤最多 ${PLAN_MAX_ITEMS} 个`);
    const seen = new Set();
    next.items = args.items.map((item) => {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || !item.title.trim()) throw fail('invalid_plan: 每步需要 id 和 title');
      if (!PLAN_STATUSES.includes(item.status)) throw fail(`invalid_plan: 状态只能是 ${PLAN_STATUSES.join('/')}`);
      const id = item.id.trim();
      if (seen.has(id)) throw fail(`invalid_plan: 步骤编号重复 ${id}`);
      seen.add(id);
      return { id, title: clip(item.title, 60), status: item.status, ...(item.note ? { note: clip(item.note, 120) } : {}) };
    });
    if (next.items.filter((item) => item.status === 'doing').length > 1) throw fail('invalid_plan: 同一时间只能有一步“进行中”');
  }
  return next;
}

// 系统提示里的计划段落：每轮都是最新状态，压缩后也不会丢。
export function renderPlanSection(plan) {
  if (!plan?.items?.length) return plan?.updatedAt ? '当前制作计划：所有步骤已完成。' : undefined;
  const lines = ['当前制作计划（你自己维护；用 plan_update 更新）：'];
  if (plan.goal) lines.push(`目标：${plan.goal}`);
  plan.items.forEach((item, index) => lines.push(`${index + 1}. [${LABEL[item.status]}] ${item.title}${item.note ? `（${item.note}）` : ''}  (${item.id})`));
  lines.push('做法：完成一步就更新计划；下一步不需要用户确认或付费时直接接着做；需要用户确认、回答或点“生成”时标 needs_user 并停下说明。出错无法继续标 blocked 并说明原因。没有实际做完的步骤不能标 done。');
  return lines.join('\n');
}

// 一轮回答结束时是否应该自动接着做下一步。预算和次数上限由调用方给出。
export function planContinuation(plan, { continuations = 0, maxContinuations = 6 } = {}) {
  if (!plan?.items?.length || continuations >= maxContinuations) return undefined;
  if (plan.items.some((item) => item.status === 'needs_user' || item.status === 'blocked')) return undefined;
  const next = plan.items.find((item) => item.status === 'doing') || plan.items.find((item) => item.status === 'todo');
  if (!next) return undefined;
  return `计划还没做完。继续做「${next.title}」；做完用 plan_update 更新状态。遇到需要用户确认、回答或点“生成”的地方，标 needs_user 并停下来。`;
}

// 给界面看的计划（不含内部字段）。
export function publicPlan(plan) {
  if (!plan?.items?.length) return null;
  const done = plan.items.filter((item) => item.status === 'done').length;
  return { goal: plan.goal || '', items: plan.items.map(({ id, title, status, note }) => ({ id, title, status, ...(note ? { note } : {}) })),
    done, total: plan.items.length, updatedAt: plan.updatedAt || '' };
}
