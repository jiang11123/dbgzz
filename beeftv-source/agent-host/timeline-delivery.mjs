// Deterministic composition inside one official Durable tool. Every side effect
// remains an existing Go operation, with its own receipt and nested task key.
export function timelineDeliveryTool(tools) {
  const required = ['canvas.get', 'canvas.timeline.update', 'canvas.timeline.render', 'canvas.nodes.create', 'canvas.task.bind', 'canvas.project.export'];
  const byOperation = new Map(tools.map(tool => [tool.label, tool]));
  if (!required.every(name => byOperation.has(name))) return null;
  const render = byOperation.get('canvas.timeline.render');
  const timelineSchema = structuredClone(byOperation.get('canvas.timeline.update').parameters.properties.timeline);
  timelineSchema.properties.clips.items.properties.lines = {
    type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' },
    description: '多行字幕逐行提供字符串；保存为真实换行，并优先于text。不要把换行转义写进每行正文。',
  };
  return {
    name: 'canvas_timeline_deliver', label: 'canvas.timeline.deliver', readOnly: false, replay: 'safe',
    description: '用户需要成片和可编辑工程时使用本组合工具，一次免费完成时间线交付：可先保存timeline，再渲染、等待文件、创建空成片节点并绑定、导出可编辑工程。不必拆成多次模型调用。局部重生成且剪辑不变时只传refreshNodeIds，精确更新指定节点的素材引用并保留字幕、时序、裁剪、声音和输出规格；它与timeline二选一。两者均省略则使用已保存时间线。仅处理已有素材，不生成付费素材。expectedRevision必须是当前画布版本。成功后检查成片。失败保留回执，只用failedStep对应原生工具及原任务继续。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        expectedRevision: render.parameters.properties.expectedRevision,
        timeline: timelineSchema,
        refreshNodeIds: byOperation.get('canvas.timeline.update').parameters.properties.refreshNodeIds,
        options: render.parameters.properties.options,
        title: { type: 'string', maxLength: 120, description: '新成片节点名称；默认“成片”' },
        ...(render.parameters.properties.canvasId ? { canvasId: render.parameters.properties.canvasId } : {}),
      },
      required: ['expectedRevision'],
    },
    execute: async (_id, args, signal, api) => {
      if (args.timeline !== undefined && args.refreshNodeIds !== undefined) throw new Error('invalid_params: timeline 与 refreshNodeIds 二选一');
      const receipts = {};
      const canvas = args.canvasId === undefined ? {} : { canvasId: args.canvasId };
      let step;
      async function call(operation, params, key) {
        signal?.throwIfAborted();
        step = operation;
        const stage = { 'canvas.timeline.update': 'checking', 'canvas.timeline.render': 'rendering',
          'canvas.nodes.create': 'binding', 'canvas.task.bind': 'binding', 'canvas.project.export': 'exporting' }[operation];
        if (stage) await api.reportProgress?.({ stage });
        const reply = await api.executeTool(byOperation.get(operation).name, { ...canvas, ...params }, { key });
        if (reply.isError) {
          const error = new Error(reply.diagnostics?.map(item => item.message || '').filter(Boolean).join('; ') || '业务步骤失败');
          error.deliveryStep = true;
          error.details = reply.structuredOutput;
          throw error;
        }
        const value = typeof reply.structuredOutput === 'string' ? JSON.parse(reply.structuredOutput) : reply.structuredOutput;
        if (!value?.result || typeof value.result !== 'object') throw new Error('delivery_receipt_missing');
        receipts[key] = value.result;
        return value.result;
      }
      function response(result, isError = false) {
        return { content: [{ type: 'text', text: JSON.stringify({ result, receipts }) }], ...(isError ? { isError: true } : {}) };
      }
      try {
        let revision = args.expectedRevision;
        if (args.refreshNodeIds !== undefined) {
          const updated = await call('canvas.timeline.update', { expectedRevision: revision, refreshNodeIds: args.refreshNodeIds }, 'timeline');
          revision = updated.revision;
        }
        if (args.timeline !== undefined) {
          const timeline = { ...args.timeline, clips: args.timeline.clips.map(clip => {
            if (clip.kind !== 'subtitle' || !Array.isArray(clip.lines)) return clip;
            const { lines, ...rest } = clip;
            return { ...rest, text: lines.join('\n') };
          }) };
          const updated = await call('canvas.timeline.update', { expectedRevision: revision, timeline }, 'timeline');
          revision = updated.revision;
        }
        const rendered = await call('canvas.timeline.render', { expectedRevision: revision, ...(args.options ? { options: args.options } : {}) }, 'render');
        if (rendered.status !== 'succeeded') {
          return response({ ...rendered, failedStep: 'canvas.timeline.render', note: '保留原任务；查询该任务，不重新渲染。' }, ['failed', 'cancelled'].includes(rendered.status));
        }
        // Reading names does not rebase over an edit made while rendering:
        // creation still checks the exact saved revision this render used.
        const names = new Set();
        let offset = 0, namesRevision;
        do {
          const key = `names:${offset}`;
          const current = await call('canvas.get', { readView: { section: 'nodes', offset,
            ...(namesRevision === undefined ? {} : { expectedRevision: namesRevision }) } }, key);
          delete receipts[key]; // Do not expose source prompts in the delivery receipt.
          if (!Array.isArray(current.canvas?.nodeIndex)) throw new Error('delivery_canvas_missing');
          namesRevision = current.canvas.revision;
          for (const node of current.canvas.nodeIndex) {
            if (node.titleComplete !== false) names.add(String(node.title || '').trim());
          }
          offset = current.readView.nodeIndexPage.nextOffset;
        } while (Number.isSafeInteger(offset));
        const requestedTitle = String(args.title || '').trim() || '成片';
        let title = requestedTitle;
        for (let index = 2; names.has(title); index++) {
          const suffix = ` · ${index}`;
          title = requestedTitle.slice(0, 120 - suffix.length) + suffix;
        }
        const created = await call('canvas.nodes.create', { expectedRevision: revision,
          nodes: [{ type: 'video', title }] }, 'node');
        const nodeId = created.created?.[0]?.id;
        if (!nodeId) throw new Error('delivery_node_missing');
        const bound = await call('canvas.task.bind', { taskId: rendered.taskId, nodeId, outputIndex: 0 }, 'bind');
        if (bound.bindingStatus !== 'bound' || !Number.isSafeInteger(bound.revision)) throw new Error('delivery_binding_missing');
        const project = await call('canvas.project.export', { expectedRevision: bound.revision }, 'project');
        return response({ status: 'delivered', canvasId: bound.canvasId, revision: bound.revision, nodeId,
          taskId: rendered.taskId, project, local: true, charged: false,
          note: '视频和可编辑工程已保存；尚须读取成片检查实际画面、声音及字幕。' });
      } catch (error) {
        if (signal?.aborted || !error.deliveryStep) throw error;
        return response({ status: 'incomplete', failedStep: step, error: error.message, details: error.details,
          taskId: receipts.render?.taskId, nodeId: receipts.node?.created?.[0]?.id,
          note: '已完成步骤和原任务保留；只继续失败步骤，不重复生成或渲染。' }, true);
      }
    },
  };
}
