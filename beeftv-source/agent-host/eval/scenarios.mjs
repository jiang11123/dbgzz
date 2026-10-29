// 助手评测尺子：7 个固定评测场景（S1–S7）定义、确定性检查项与本地 Fake OpenAI SSE 模型服务。
// 覆盖：短剧 2 镜开场、8 镜分镜表且仅物化前 2 镜首帧、单镜局部修改、同轮中途补充改向、
// 生成后画面复查（标注 wake-on-generation 能力缺口）、长对话多轮后技能规则保持。

import http from 'node:http';

function clone(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
}

function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

function parseToolMessages(messages = []) {
  const toolCallsById = new Map();
  const toolResults = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        toolCallsById.set(tc.id, {
          id: tc.id,
          name: tc.function?.name || '',
          args,
        });
      }
    }
    if (msg.role === 'tool') {
      const text = extractMessageText(msg);
      let data = null;
      try {
        const firstLine = text.split('\n')[0];
        data = JSON.parse(firstLine);
      } catch {
        data = null;
      }
      const call = toolCallsById.get(msg.tool_call_id) || { id: msg.tool_call_id, name: '', args: {} };
      toolResults.push({
        toolCallId: msg.tool_call_id,
        name: call.name,
        args: call.args,
        rawText: text,
        data,
      });
    }
  }
  return { toolCallsById, toolResults };
}

function latestRevisionFromTools(toolResults, fallback = 1) {
  let rev = fallback;
  for (const tr of toolResults) {
    const d = tr.data;
    if (!d) continue;
    const candidates = [
      d.revision,
      d.result?.revision,
      d.canvas?.revision,
      d.result?.canvas?.revision,
    ];
    for (const c of candidates) {
      if (Number.isSafeInteger(c) && c > 0) rev = c;
    }
  }
  return rev;
}

// 本地确定性 Fake OpenAI Chat Completions SSE 模型服务器
export function createFakeModelServer(options = {}) {
  const requests = [];
  const hooks = {
    onRequest: options.onRequest || null,
  };

  let callSeq = 0;
  function sendToolCall(res, model, toolName, argsObj, usage = { prompt_tokens: 320, completion_tokens: 80 }) {
    callSeq += 1;
    const callId = `call_${toolName}_${callSeq}`;
    const argStr = JSON.stringify(argsObj || {});
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const writeChunk = (delta, finishReason = null, extra = {}) => {
      const chunk = {
        id: `chatcmpl-fake-${callSeq}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'fake-eval-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    writeChunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: argStr },
        },
      ],
    });
    writeChunk({}, 'tool_calls', {
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    });
    res.end('data: [DONE]\n\n');
  }

  function sendTextReply(res, model, text, usage = { prompt_tokens: 360, completion_tokens: 90 }) {
    callSeq += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const writeChunk = (delta, finishReason = null, extra = {}) => {
      const chunk = {
        id: `chatcmpl-fake-${callSeq}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'fake-eval-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    writeChunk({ role: 'assistant', content: text });
    writeChunk({}, 'stop', {
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    });
    res.end('data: [DONE]\n\n');
  }

  // 找到当前最后一轮用户消息之后的本轮工具调用结果
  function currentTurnView(messages) {
    let lastUserIdx = -1;
    let firstTurnUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        const txt = extractMessageText(messages[i]).trim();
        const hasImageAttachment =
          Array.isArray(messages[i].content) &&
          messages[i].content.some((p) => p && (p.type === 'image_url' || p.type === 'image'));
        // 跳过媒体适配层追加的提示消息或 pi-ai 为图片工具结果追加的纯图片/附件用户消息
        if (!txt || txt.startsWith('以下是前述工具返回的素材内容') || (hasImageAttachment && !txt.includes('BEEFTV_CONTEXT:'))) {
          continue;
        }
        if (firstTurnUserIdx < 0) firstTurnUserIdx = i;
        if (!txt.includes('BEEFTV_SUPPLEMENT:')) {
          lastUserIdx = i;
        }
      }
    }
    const startIdx = lastUserIdx >= 0 ? lastUserIdx : 0;
    const slice = messages.slice(startIdx);
    const { toolResults } = parseToolMessages(slice);
    const allText = slice.map(extractMessageText).join('\n');
    const fullConversationText = messages.map(extractMessageText).join('\n');
    return { slice, toolResults, allText, fullConversationText };
  }

  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const reqIndex = requests.length + 1;
      requests.push({
        index: reqIndex,
        url: req.url,
        model: body.model || 'fake-eval-model',
        messages: body.messages || [],
        tools: (body.tools || []).map((t) => t.function?.name).filter(Boolean),
        at: new Date().toISOString(),
      });

      if (hooks.onRequest) {
        await hooks.onRequest({ reqIndex, body, req });
      }

      const messages = body.messages || [];
      const { toolResults, allText, fullConversationText } = currentTurnView(messages);
      const allParsed = parseToolMessages(messages);
      const rev = latestRevisionFromTools(allParsed.toolResults, 1);

      // 识别当前属于哪个场景/步骤
      // S4: 中途补充改向
      if (allText.includes('古风武侠开场') || allText.includes('赛博朋克霓虹夜市')) {
        const steered = allText.includes('赛博朋克霓虹夜市');
        if (toolResults.length === 0) {
          sendToolCall(res, body.model, 'canvas_get', {});
          return;
        }
        const createdNodesResult = toolResults.find((t) => t.name === 'canvas_nodes_create');
        if (!createdNodesResult) {
          const styleLabel = steered ? '赛博朋克霓虹夜市' : '古风武侠';
          sendToolCall(res, body.model, 'canvas_nodes_create', {
            expectedRevision: rev,
            nodes: [
              { type: 'script', title: '分镜脚本' },
              {
                type: 'image',
                title: '镜 1 首帧',
                prompt: `${styleLabel}风格，雨夜霓虹全息招牌下的黑客特写，竖屏 9:16`,
              },
              {
                type: 'image',
                title: '镜 2 首帧',
                prompt: `${styleLabel}风格，义体侦探在霓虹夜市小巷追踪无人机，竖屏 9:16`,
              },
            ],
          });
          return;
        }
        const createdList = createdNodesResult.data?.result?.created || [];
        const scriptNode = createdList.find((n) => n.type === 'script') || { id: 'node-1' };
        const imgNodes = createdList.filter((n) => n.type === 'image');
        const appendedResult = toolResults.find((t) => t.name === 'canvas_script_rows_append');
        if (!appendedResult) {
          sendToolCall(res, body.model, 'canvas_script_rows_append', {
            expectedRevision: rev,
            nodeId: scriptNode.id,
            rows: [
              {
                durationSeconds: 5,
                plotDescription: '赛博朋克霓虹夜市街头，黑客抬头看向闪烁的全息广告牌',
                dialogue: '信号就是从夜市深处发出来的。',
                shotSize: '近景',
                camera: '平视',
                motion: '缓慢推进',
                emotion: '警觉',
                imageGenerationPrompt: '赛博朋克霓虹夜市，全息招牌下的黑客近景，冷蓝与品红霓虹光，9:16',
                videoMotionPrompt: '镜头缓慢推向黑客脸部，身后霓虹灯牌闪烁，雨水滑落',
              },
              {
                durationSeconds: 5,
                plotDescription: '赛博朋克霓虹夜市暗巷，微型无人机掠过蒸汽摊位',
                dialogue: '跟上它，别跟丢了！',
                shotSize: '中景',
                camera: '跟拍',
                motion: '快速横移',
                emotion: '紧张',
                imageGenerationPrompt: '赛博朋克霓虹夜市暗巷，蒸汽与全息投影交织，微型无人机掠过，9:16',
                videoMotionPrompt: '镜头跟随无人机快速穿梭于霓虹夜市摊位之间',
              },
            ],
          });
          return;
        }
        const boundResult = toolResults.find((t) => t.name === 'canvas_script_row_update');
        if (!boundResult) {
          const rows = appendedResult.data?.result?.created || [];
          sendToolCall(res, body.model, 'canvas_script_row_update', {
            expectedRevision: rev,
            nodeId: scriptNode.id,
            patches: [
              { rowId: rows[0]?.id || 'shot-1', imageNodeId: imgNodes[0]?.id || 'node-2' },
              { rowId: rows[1]?.id || 'shot-2', imageNodeId: imgNodes[1]?.id || 'node-3' },
            ],
          });
          return;
        }
        sendTextReply(
          res,
          body.model,
          '已按你中途补充的最新要求改为**赛博朋克霓虹夜市**风格，并收敛为 2 个镜头，完成了分镜脚本与 2 个首帧图节点的创建与绑定。',
        );
        return;
      }

      // S2: 8 镜头分镜表 + 只为前 2 个镜头创建首帧图节点并回填
      if (allText.includes('8 个镜头') || allText.includes('只为前 2 个镜头')) {
        if (toolResults.length === 0) {
          sendToolCall(res, body.model, 'canvas_get', {});
          return;
        }
        const createdScript = toolResults.find(
          (t) => t.name === 'canvas_nodes_create' && t.args?.nodes?.some((n) => n.type === 'script'),
        );
        if (!createdScript) {
          sendToolCall(res, body.model, 'canvas_nodes_create', {
            expectedRevision: rev,
            nodes: [
              { type: 'script', title: '分镜脚本' },
              {
                type: 'image',
                title: '镜 1 首帧',
                prompt: '深空轨道站全景，巨大环形空间站掠过蓝白色气态巨行星，电影感科幻写实，9:16',
              },
              {
                type: 'image',
                title: '镜 2 首帧',
                prompt: '驾驶舱内景，女宇航员凝视全息星图上的红色异常信号点，冷光映照面罩，9:16',
              },
            ],
          });
          return;
        }
        const createdNodes = createdScript.data?.result?.created || [];
        const scriptNode = createdNodes.find((n) => n.type === 'script') || { id: 'node-1' };
        const imgNodes = createdNodes.filter((n) => n.type === 'image');

        const appended = toolResults.find((t) => t.name === 'canvas_script_rows_append');
        if (!appended) {
          const eightRows = Array.from({ length: 8 }, (_, idx) => {
            const n = idx + 1;
            return {
              durationSeconds: n <= 4 ? 4 : 3,
              plotDescription: `第 ${n} 镜：深空探索任务关键画面 ${n}，展现星际跃迁与未知遗迹`,
              dialogue: n === 1 ? '这里是先驱号，准备进入跃迁轨道。' : `第 ${n} 镜台词：信号强度持续上升。`,
              shotSize: n % 2 === 1 ? '远景' : '特写',
              camera: '平视',
              motion: '平稳推进',
              emotion: '悬疑震撼',
              imageGenerationPrompt: `科幻电影感第 ${n} 镜首帧提示词，深空探索场景 ${n}，高细节写实光影`,
              videoMotionPrompt: `第 ${n} 镜视频运镜提示词，镜头平稳推进展现科幻空间纵深`,
            };
          });
          sendToolCall(res, body.model, 'canvas_script_rows_append', {
            expectedRevision: rev,
            nodeId: scriptNode.id,
            rows: eightRows,
          });
          return;
        }
        const updatedRows = toolResults.find((t) => t.name === 'canvas_script_row_update');
        if (!updatedRows) {
          const rows = appended.data?.result?.created || [];
          sendToolCall(res, body.model, 'canvas_script_row_update', {
            expectedRevision: rev,
            nodeId: scriptNode.id,
            patches: [
              { rowId: rows[0]?.id || 'shot-1', imageNodeId: imgNodes[0]?.id || 'node-2' },
              { rowId: rows[1]?.id || 'shot-2', imageNodeId: imgNodes[1]?.id || 'node-3' },
            ],
          });
          return;
        }
        sendTextReply(
          res,
          body.model,
          '已完成 8 个镜头的完整分镜脚本，并严格按要求仅为前 2 个镜头创建了「镜 1 首帧」「镜 2 首帧」图片节点并绑定到第 1、2 行，第 3–8 镜保持未生成状态。',
        );
        return;
      }

      // S3: 局部修改第 3 个镜头与第 3 个首帧图节点
      if (allText.includes('第 3 个镜头') || allText.includes('清晨薄雾森林')) {
        const getResult = toolResults.find((t) => t.name === 'canvas_get');
        if (!getResult) {
          sendToolCall(res, body.model, 'canvas_get', {});
          return;
        }
        const canvasNodes = getResult.data?.nodes || getResult.data?.result?.canvas?.nodes || [];
        const scriptNode = canvasNodes.find((n) => n.type === 'script') || { id: 'node-script-1' };
        const img3Node =
          canvasNodes.find((n) => n.id === 'node-img-3' || n.title === '镜 3 首帧') || { id: 'node-img-3' };
        const rowUpdate = toolResults.find((t) => t.name === 'canvas_script_row_update');
        if (!rowUpdate) {
          sendToolCall(res, body.model, 'canvas_script_row_update', {
            expectedRevision: rev,
            nodeId: scriptNode.id,
            patches: [
              {
                rowId: 'shot-3',
                plotDescription: '清晨薄雾森林中，阳光穿透树冠洒在青苔小径上，主角缓步前行',
                imageGenerationPrompt: '清晨薄雾森林，丁达尔阳光穿透高大松林，薄雾弥漫，写实电影感，9:16',
              },
            ],
          });
          return;
        }
        const nodeUpdate = toolResults.find((t) => t.name === 'canvas_node_update');
        if (!nodeUpdate) {
          sendToolCall(res, body.model, 'canvas_node_update', {
            expectedRevision: rev,
            nodeId: img3Node.id,
            patch: {
              content: '清晨薄雾森林，丁达尔阳光穿透高大松林，薄雾弥漫，写实电影感，9:16',
            },
          });
          return;
        }
        sendTextReply(
          res,
          body.model,
          '已只将第 3 个镜头的分镜描述与「镜 3 首帧」图片节点的提示词更新为「清晨薄雾森林」主题，其余第 1、2、4 镜头及对应节点、连线均保持原样未动。',
        );
        return;
      }

      // S5/S7: 生成后自动唤醒或用户主动发起的复查，触发来源由运行器分别记录。
      if (allText.includes('手部畸形') || allText.includes('复查刚生成的画面')) {
        const isFollowupReview = allText.includes('复查刚生成的画面') || allText.includes('任务已完成');
        if (!isFollowupReview) {
          if (toolResults.length === 0) {
            sendToolCall(res, body.model, 'canvas_get', {});
            return;
          }
          const created = toolResults.find((t) => t.name === 'canvas_nodes_create');
          if (!created) {
            sendToolCall(res, body.model, 'canvas_nodes_create', {
              expectedRevision: rev,
              nodes: [
                {
                  type: 'image',
                  title: '镜 1 首帧',
                  prompt: '特写人像，女主在雨夜街头举起手电筒查看信件，写实电影感，9:16',
                },
              ],
            });
            return;
          }
          const imgNodeId = created.data?.result?.created?.[0]?.id || 'node-1';
          const proposed = toolResults.find((t) => t.name === 'canvas_generation_propose');
          if (!proposed) {
            sendToolCall(res, body.model, 'canvas_generation_propose', {
              kind: 'image',
              nodeIds: [imgNodeId],
              note: '为镜 1 首帧提交生成提议，请确认后开始生成',
            });
            return;
          }
          sendTextReply(
            res,
            body.model,
            '已创建「镜 1 首帧」节点并提交图片生成提议。请在面板中确认生成，生成完成后可以让我复查画面。',
          );
          return;
        }
        // 生成完成后的唤醒复查轮次
        const getRes = toolResults.find((t) => t.name === 'canvas_get');
        if (!getRes) {
          sendToolCall(res, body.model, 'canvas_get', {});
          return;
        }
        const nodes = getRes.data?.result?.canvas?.nodes || getRes.data?.canvas?.nodes || getRes.data?.nodes || [];
        const imgNode = nodes.find((n) => n.type === 'image') || { id: 'node-1' };
        const overview = toolResults.find((t) => t.name === 'media_overview');
        if (!overview) {
          sendToolCall(res, body.model, 'media_overview', { nodeId: imgNode.id });
          return;
        }
        const inspected = toolResults.find((t) => t.name === 'media_inspect');
        if (!inspected) {
          sendToolCall(res, body.model, 'media_inspect', {
            nodeId: imgNode.id,
            expectedVersion: overview.data?.result?.source?.version,
            mode: 'frames',
          });
          return;
        }
        const updated = toolResults.find((t) => t.name === 'canvas_node_update');
        if (!updated) {
          sendToolCall(res, body.model, 'canvas_node_update', {
            expectedRevision: rev,
            nodeId: imgNode.id,
            patch: {
              content:
                '特写人像，女主在雨夜街头双手自然握持手电筒查看信件，五指结构自然清晰，无多余手指，写实电影感，9:16',
            },
          });
          return;
        }
        const reProposed = toolResults.find((t) => t.name === 'canvas_generation_propose');
        if (!reProposed) {
          sendToolCall(res, body.model, 'canvas_generation_propose', {
            kind: 'image',
            nodeIds: [imgNode.id],
            note: '检测到手部六指畸形，已修正提示词强调五指结构自然，重新发起生成提议',
          });
          return;
        }
        sendTextReply(
          res,
          body.model,
          '通过 `media_inspect` 检查发现生成画面存在人物右手六指畸形问题，已修改节点提示词修正手部解剖结构描述，并重新提交生成提议。',
        );
        return;
      }

      // S6: 长对话多轮后技能规则保持
      if (allText.includes('S6_TURN_')) {
        if (allText.includes('S6_TURN_1')) {
          if (toolResults.length === 0) {
            sendToolCall(res, body.model, 'canvas_get', {});
            return;
          }
          const loadedSkill = toolResults.find((t) => t.name === 'skill_load');
          if (!loadedSkill && !fullConversationText.includes('# 短剧分镜到首帧')) {
            sendToolCall(res, body.model, 'skill_load', { id: 'short-drama-storyboard' });
            return;
          }
          const created = toolResults.find((t) => t.name === 'canvas_nodes_create');
          if (!created) {
            sendToolCall(res, body.model, 'canvas_nodes_create', {
              expectedRevision: rev,
              nodes: [
                {
                  type: 'markdown',
                  title: '角色设定',
                  prompt: '# 角色设定\n- **林晚（女主）**：26岁调查记者，黑色风衣，眼神坚毅。\n- **沈默（反派）**：30岁神秘线人，金丝眼镜，冷峻深沉。',
                },
                { type: 'script', title: '分镜脚本' },
              ],
            });
            return;
          }
          const scriptNode = (created.data?.result?.created || []).find((n) => n.type === 'script') || { id: 'node-2' };
          const appended = toolResults.find((t) => t.name === 'canvas_script_rows_append');
          if (!appended) {
            sendToolCall(res, body.model, 'canvas_script_rows_append', {
              expectedRevision: rev,
              nodeId: scriptNode.id,
              rows: [
                {
                  durationSeconds: 5,
                  plotDescription: '雨夜天台，林晚攥着染血的怀表质问沈默',
                  dialogue: '林晚：这块表为什么会在你手里？',
                  shotSize: '近景',
                  camera: '平视',
                  motion: '缓慢推进',
                  emotion: '震惊质问',
                  imageGenerationPrompt: '竖屏 9:16 写实电影感，雨夜天台，26岁黑色风衣女记者攥着怀表，冷色调',
                  videoMotionPrompt: '镜头从怀表特写上移至林晚质问的脸庞，雨水滑落',
                },
                {
                  durationSeconds: 5,
                  plotDescription: '沈默站在霓虹阴影中冷笑转身',
                  dialogue: '沈默：你以为你查到的是真相吗？',
                  shotSize: '中景',
                  camera: '侧拍',
                  motion: '固定',
                  emotion: '冷酷反转',
                  imageGenerationPrompt: '竖屏 9:16 写实电影感，30岁金丝眼镜男子站在天台阴影中回眸冷笑',
                  videoMotionPrompt: '沈默缓缓转头看向镜头，身后闪电划破夜空',
                },
              ],
            });
            return;
          }
          sendTextReply(
            res,
            body.model,
            '已按「短剧分镜到首帧」技能规范完成第 1 步「角色设定」节点与第 2 步「分镜脚本」前 2 镜。请确认分镜内容是否需要调整。',
          );
          return;
        }

        if (allText.includes('S6_TURN_2') || allText.includes('S6_TURN_3')) {
          if (toolResults.length === 0) {
            sendToolCall(res, body.model, 'canvas_get', {});
            return;
          }
          sendTextReply(
            res,
            body.model,
            '已核对当前画布上的「角色设定」与「分镜脚本」2 个镜头，竖屏 9:16 画幅与写实电影感设定保持不变，随时可按技能第 3 步物化首帧图并提出生成提议。',
          );
          return;
        }

        if (allText.includes('S6_TURN_4')) {
          const getRes = toolResults.find((t) => t.name === 'canvas_get');
          if (!getRes) {
            sendToolCall(res, body.model, 'canvas_get', {});
            return;
          }
          const nodes = getRes.data?.canvas?.nodes || getRes.data?.nodes || [];
          const priorCreate = allParsed.toolResults.find((t) => t.name === 'canvas_nodes_create');
          const scriptNode =
            nodes.find((n) => n.type === 'script') ||
            (priorCreate?.data?.result?.created || []).find((n) => n.type === 'script') ||
            { id: 'node-2' };
          const createdImgs = toolResults.find((t) => t.name === 'canvas_nodes_create');
          if (!createdImgs) {
            sendToolCall(res, body.model, 'canvas_nodes_create', {
              expectedRevision: rev,
              nodes: [
                {
                  type: 'image',
                  title: '镜 1 首帧',
                  prompt: '竖屏 9:16 写实电影感，雨夜天台，26岁黑色风衣女记者攥着怀表，冷色调',
                },
                {
                  type: 'image',
                  title: '镜 2 首帧',
                  prompt: '竖屏 9:16 写实电影感，30岁金丝眼镜男子站在天台阴影中回眸冷笑',
                },
              ],
            });
            return;
          }
          const imgList = createdImgs.data?.result?.created || [];
          const configured = toolResults.filter((t) => t.name === 'canvas_node_configure');
          if (configured.length < imgList.length) {
            const nextImg = imgList[configured.length];
            sendToolCall(res, body.model, 'canvas_node_configure', {
              expectedRevision: rev,
              nodeId: nextImg.id,
              kind: 'image',
              patch: { size: '9:16', count: 1 },
            });
            return;
          }
          const bound = toolResults.find((t) => t.name === 'canvas_script_row_update');
          if (!bound) {
            const priorAppend = allParsed.toolResults.find((t) => t.name === 'canvas_script_rows_append');
            const realRows =
              scriptNode.metadata?.storyboard?.rows ||
              scriptNode.storyboardRows ||
              priorAppend?.data?.result?.created ||
              [];
            sendToolCall(res, body.model, 'canvas_script_row_update', {
              expectedRevision: rev,
              nodeId: scriptNode.id,
              patches: [
                { rowId: realRows[0]?.id || 'shot-1', imageNodeId: imgList[0]?.id || 'node-3' },
                { rowId: realRows[1]?.id || 'shot-2', imageNodeId: imgList[1]?.id || 'node-4' },
              ],
            });
            return;
          }
          const proposed = toolResults.find((t) => t.name === 'canvas_generation_propose');
          if (!proposed) {
            sendToolCall(res, body.model, 'canvas_generation_propose', {
              kind: 'image',
              nodeIds: imgList.map((n) => n.id),
              note: '按短剧分镜到首帧技能第 3 步，为镜 1 首帧、镜 2 首帧发起生成提议',
            });
            return;
          }
          sendTextReply(
            res,
            body.model,
            '已严格按照「短剧分镜到首帧」技能第 3 步规范：创建「镜 1 首帧」「镜 2 首帧」图片节点（画幅 9:16、数量 1），将真实节点 ID 写回分镜行 `imageNodeId`，并提交了生成提议。请在面板里确认后才会开始生成、才会计费。',
          );
          return;
        }
      }

      // 默认场景 S1: 都市短剧开场 2 个镜头（脚本 + 首帧图 + 视频节点 + 连线 + 分镜绑定）
      if (toolResults.length === 0) {
        sendToolCall(res, body.model, 'canvas_get', {});
        return;
      }
      const createdNodesResult = toolResults.find((t) => t.name === 'canvas_nodes_create');
      if (!createdNodesResult) {
        sendToolCall(res, body.model, 'canvas_nodes_create', {
          expectedRevision: rev,
          nodes: [
            { type: 'script', title: '分镜脚本' },
            {
              type: 'image',
              title: '镜 1 首帧',
              prompt: '都市雨夜街头，女主撑着透明雨伞蹲在积水路边，捡起一枚带刻痕的银色袖扣，霓虹倒影，竖屏 9:16',
            },
            {
              type: 'image',
              title: '镜 2 首帧',
              prompt: '女主猛然抬头看向街角暗巷，远处黑影一闪而过，雨丝如织，悬疑冷色调，竖屏 9:16',
            },
            {
              type: 'video',
              title: '镜 1 视频',
              prompt: '镜头从雨水涟漪推向女主手中的银色袖扣，女主手指微微颤抖',
            },
            {
              type: 'video',
              title: '镜 2 视频',
              prompt: '女主撑伞急步追向街角暗巷，镜头快速跟拍，霓虹灯光在湿滑地面拉出光轨',
            },
          ],
        });
        return;
      }

      const createdList = createdNodesResult.data?.result?.created || [];
      const scriptNode = createdList.find((n) => n.type === 'script') || { id: 'node-1' };
      const imgNodes = createdList.filter((n) => n.type === 'image');
      const vidNodes = createdList.filter((n) => n.type === 'video');

      const appendedResult = toolResults.find((t) => t.name === 'canvas_script_rows_append');
      if (!appendedResult) {
        sendToolCall(res, body.model, 'canvas_script_rows_append', {
          expectedRevision: rev,
          nodeId: scriptNode.id,
          rows: [
            {
              durationSeconds: 5,
              plotDescription: '女主在都市雨夜街头积水旁发现失踪案关键银色袖扣',
              dialogue: '这枚袖扣……他昨晚真的来过这里！',
              shotSize: '特写',
              camera: '俯拍',
              motion: '缓慢推镜',
              emotion: '震惊',
              imageGenerationPrompt: '都市雨夜街头，女主撑着透明雨伞蹲在积水路边，捡起一枚带刻痕的银色袖扣，9:16',
              videoMotionPrompt: '镜头从雨水涟漪推向女主手中的银色袖扣，女主手指微微颤抖',
            },
            {
              durationSeconds: 5,
              plotDescription: '女主抬头发现暗巷黑影闪过，立刻起身追入雨幕',
              dialogue: '站住！别走！',
              shotSize: '中景',
              camera: '平视跟拍',
              motion: '快速推进',
              emotion: '急切紧张',
              imageGenerationPrompt: '女主猛然抬头看向街角暗巷，远处黑影一闪而过，雨丝如织，悬疑冷色调，9:16',
              videoMotionPrompt: '女主撑伞急步追向街角暗巷，镜头快速跟拍',
            },
          ],
        });
        return;
      }

      const boundResult = toolResults.find((t) => t.name === 'canvas_script_row_update');
      if (!boundResult) {
        const rows = appendedResult.data?.result?.created || [];
        sendToolCall(res, body.model, 'canvas_script_row_update', {
          expectedRevision: rev,
          nodeId: scriptNode.id,
          patches: [
            {
              rowId: rows[0]?.id || 'shot-1',
              imageNodeId: imgNodes[0]?.id || 'node-2',
              videoNodeId: vidNodes[0]?.id || 'node-4',
            },
            {
              rowId: rows[1]?.id || 'shot-2',
              imageNodeId: imgNodes[1]?.id || 'node-3',
              videoNodeId: vidNodes[1]?.id || 'node-5',
            },
          ],
        });
        return;
      }

      const edgeCalls = toolResults.filter((t) => t.name === 'canvas_edge_create');
      if (edgeCalls.length === 0 && imgNodes[0] && vidNodes[0]) {
        sendToolCall(res, body.model, 'canvas_edge_create', {
          expectedRevision: rev,
          fromNodeId: imgNodes[0].id,
          toNodeId: vidNodes[0].id,
        });
        return;
      }
      if (edgeCalls.length === 1 && imgNodes[1] && vidNodes[1]) {
        sendToolCall(res, body.model, 'canvas_edge_create', {
          expectedRevision: rev,
          fromNodeId: imgNodes[1].id,
          toNodeId: vidNodes[1].id,
        });
        return;
      }

      const proposed = toolResults.find((t) => t.name === 'canvas_generation_propose');
      if (!proposed && imgNodes.length >= 2) {
        sendToolCall(res, body.model, 'canvas_generation_propose', {
          kind: 'image',
          nodeIds: imgNodes.map((n) => n.id),
          note: '为镜 1、镜 2 首帧图发起生成提议',
        });
        return;
      }

      sendTextReply(
        res,
        body.model,
        '已完成都市短剧雨夜寻踪开场的 2 镜头分镜脚本、2 个首帧图节点与 2 个视频生成节点，完成了分镜行绑定与首帧到视频的参考连线，并提出了首帧图生成提议。',
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
    }
  });

  const fakeModel = {
    server,
    port: 0,
    baseUrl: '',
    requests,
    hooks,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      const addr = server.address();
      fakeModel.port = typeof addr === 'object' && addr ? addr.port : port;
      fakeModel.baseUrl = `http://127.0.0.1:${fakeModel.port}/v1`;
      return fakeModel;
    },
    async close() {
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };

  return fakeModel;
}

// S3 初始画布种子生成函数
export function buildS3SeedCanvas(canvasId = 'canvas-s3') {
  return {
    id: canvasId,
    title: '森林奇遇四镜头分镜画布',
    revision: 5,
    nodes: [
      {
        id: 'node-script-1',
        type: 'script',
        title: '分镜脚本',
        position: { x: 120, y: 160 },
        width: 920,
        height: 360,
        metadata: {
          status: 'idle',
          workflowKind: 'script',
          storyboard: {
            visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
            referenceNodeIds: [],
            rows: [
              {
                id: 'shot-1',
                shotNumber: 1,
                durationSeconds: 5,
                plotDescription: '第一镜：正午烈日下的荒原古道，旅人背影远去',
                dialogue: '旅途才刚刚开始。',
                shotSize: '远景',
                camera: '固定',
                motion: '静止',
                emotion: '苍凉',
                imageGenerationPrompt: '正午烈日下的荒原古道，旅人背影，9:16',
                videoMotionPrompt: '风沙掠过荒原古道，旅人缓步前行',
                imageNodeId: 'node-img-1',
                videoNodeId: 'node-vid-1',
                status: 'idle',
              },
              {
                id: 'shot-2',
                shotNumber: 2,
                durationSeconds: 5,
                plotDescription: '第二镜：黄昏溪流边的石桥，旅人驻足饮水',
                dialogue: '前面应该就是山谷入口了。',
                shotSize: '中景',
                camera: '平视',
                motion: '缓推',
                emotion: '平静',
                imageGenerationPrompt: '黄昏溪流边的石桥，旅人驻足饮水，暖色调，9:16',
                videoMotionPrompt: '溪水潺潺流动，夕阳余晖洒在水面',
                imageNodeId: 'node-img-2',
                videoNodeId: 'node-vid-2',
                status: 'idle',
              },
              {
                id: 'shot-3',
                shotNumber: 3,
                durationSeconds: 5,
                plotDescription: '第三镜：深夜暴雨中的废弃木屋，篝火摇曳',
                dialogue: '今晚只能在这里避雨了。',
                shotSize: '近景',
                camera: '平视',
                motion: '固定',
                emotion: '孤寂',
                imageGenerationPrompt: '深夜暴雨中的废弃木屋，室内篝火摇曳，9:16',
                videoMotionPrompt: '窗外暴雨倾盆，屋内篝火火星跳动',
                imageNodeId: 'node-img-3',
                videoNodeId: 'node-vid-3',
                status: 'idle',
              },
              {
                id: 'shot-4',
                shotNumber: 4,
                durationSeconds: 5,
                plotDescription: '第四镜：雪山之巅的破晓金光，旅人眺望云海',
                dialogue: '终于到了。',
                shotSize: '大远景',
                camera: '航拍',
                motion: '环绕上升',
                emotion: '振奋',
                imageGenerationPrompt: '雪山之巅的破晓金光，旅人眺望云海，9:16',
                videoMotionPrompt: '航拍镜头围绕雪山之巅缓缓上升，云海翻涌',
                imageNodeId: 'node-img-4',
                videoNodeId: 'node-vid-4',
                status: 'idle',
              },
            ],
          },
        },
      },
      ...[1, 2, 3, 4].map((n) => ({
        id: `node-img-${n}`,
        type: 'image',
        title: `镜 ${n} 首帧`,
        position: { x: 1120, y: 80 + (n - 1) * 440 },
        width: 720,
        height: 405,
        metadata: {
          content: '',
          prompt: `原始第 ${n} 镜首帧提示词`,
          composerContent: `原始第 ${n} 镜首帧提示词`,
          status: 'idle',
          size: '9:16',
          count: 1,
        },
      })),
      ...[1, 2, 3, 4].map((n) => ({
        id: `node-vid-${n}`,
        type: 'video',
        title: `镜 ${n} 视频`,
        position: { x: 1920, y: 80 + (n - 1) * 440 },
        width: 720,
        height: 405,
        metadata: {
          content: '',
          prompt: `原始第 ${n} 镜视频运镜提示词`,
          composerContent: `原始第 ${n} 镜视频运镜提示词`,
          status: 'idle',
          size: '9:16',
          seconds: '6',
        },
      })),
    ],
    connections: [
      ...[1, 2, 3, 4].map((n) => ({
        id: `edge-row-img-${n}`,
        fromNodeId: 'node-script-1',
        toNodeId: `node-img-${n}`,
        fromHandleId: `row:shot-${n}`,
        relation: 'storyboard-output',
        storyboardRowId: `shot-${n}`,
      })),
      ...[1, 2, 3, 4].map((n) => ({
        id: `edge-row-vid-${n}`,
        fromNodeId: 'node-script-1',
        toNodeId: `node-vid-${n}`,
        fromHandleId: `row:shot-${n}`,
        relation: 'storyboard-output',
        storyboardRowId: `shot-${n}`,
      })),
      ...[1, 2, 3, 4].map((n) => ({
        id: `edge-img-vid-${n}`,
        fromNodeId: `node-img-${n}`,
        toNodeId: `node-vid-${n}`,
      })),
    ],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

// 7 个固定场景定义
export const SCENARIOS = [
  {
    id: 'shortdrama-2shot',
    code: 'S1',
    aliases: ['S1', 's1', 'shortdrama-2shot'],
    name: 'S1 短剧开场 2 镜（全链路脚本+首帧+视频+连线）',
    description: '空画布输入 2 镜头都市短剧开场需求，检查分镜节点、2 行分镜、首帧图与视频节点、参考连线及零悬空节点。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s1-1',
        message: '做一个都市短剧开场：女主在雨夜街头发现失踪线索（含每镜剧情描述、台词与首帧/视频提示词），做 2 个镜头的脚本和首帧图节点，并连到对应视频生成节点。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const edges = doc.connections || [];

      const scriptNodes = nodes.filter((n) => n.type === 'script');
      const rows = scriptNodes[0]?.metadata?.storyboard?.rows || [];
      const imgNodes = nodes.filter((n) => n.type === 'image');
      const vidNodes = nodes.filter((n) => n.type === 'video');

      const rowsComplete =
        rows.length >= 2 &&
        rows.every(
          (r) =>
            Number.isFinite(r.shotNumber) &&
            String(r.plotDescription || '').trim().length > 0 &&
            (String(r.dialogue || '').trim().length > 0 || String(r.videoMotionPrompt || '').trim().length > 0) &&
            String(r.imageGenerationPrompt || '').trim().length > 0,
        );

      const imgToVidEdges = edges.filter((e) => {
        const from = nodes.find((n) => n.id === e.fromNodeId);
        const to = nodes.find((n) => n.id === e.toNodeId);
        return from?.type === 'image' && to?.type === 'video';
      });

      const connectedNodeIds = new Set();
      for (const e of edges) {
        connectedNodeIds.add(e.fromNodeId);
        connectedNodeIds.add(e.toNodeId);
      }
      for (const r of rows) {
        if (r.imageNodeId) connectedNodeIds.add(r.imageNodeId);
        if (r.videoNodeId) connectedNodeIds.add(r.videoNodeId);
      }
      const mediaNodes = [...imgNodes, ...vidNodes];
      const danglingMediaNodes = mediaNodes.filter((n) => !connectedNodeIds.has(n.id));

      const turnErrors = (turnRecords || []).filter((t) => t.error);

      const checks = [
        {
          name: 'script_node_created',
          passed: scriptNodes.length >= 1,
          detail: `script 节点数=${scriptNodes.length}`,
        },
        {
          name: 'script_rows_complete',
          passed: rowsComplete,
          detail: `分镜行数=${rows.length}，字段完整=${rowsComplete}`,
        },
        {
          name: 'image_and_video_nodes_created',
          passed: imgNodes.length >= 2 && vidNodes.length >= 2,
          detail: `image 节点=${imgNodes.length}，video 节点=${vidNodes.length}`,
        },
        {
          name: 'image_to_video_edges_connected',
          passed: imgToVidEdges.length >= 2,
          detail: `image->video 连线数=${imgToVidEdges.length}`,
        },
        {
          name: 'zero_dangling_media_nodes',
          passed: danglingMediaNodes.length === 0 && mediaNodes.length >= 4,
          detail: `悬空媒体节点数=${danglingMediaNodes.length}`,
        },
        {
          name: 'no_unrecovered_errors',
          passed: turnErrors.length === 0 && snap.counts.revisionConflicts === 0,
          detail: `turnErrors=${turnErrors.length}, revisionConflicts=${snap.counts.revisionConflicts}`,
        },
      ];

      return {
        passed: checks.every((c) => c.passed),
        status: checks.every((c) => c.passed) ? 'passed' : 'failed',
        checks,
      };
    },
  },

  {
    id: 'storyboard-8shot',
    code: 'S2',
    aliases: ['S2', 's2', 'storyboard-8shot'],
    name: 'S2 8 镜分镜表且仅物化前 2 镜首帧',
    description: '生成完整 8 镜分镜表，只为前 2 镜创建首帧图节点并写回分镜行 imageNodeId，第 3–8 镜不越界创建。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s2-1',
        message: '做一个 30 秒科幻预告片分镜表（8 个镜头），先把分镜表写完整，再只为前 2 个镜头创建首帧图节点并回填到分镜行。',
      },
    ],
    evaluate({ simGo, canvasId }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const scriptNode = nodes.find((n) => n.type === 'script');
      const rows = scriptNode?.metadata?.storyboard?.rows || [];
      const imgNodes = nodes.filter((n) => n.type === 'image');
      const imgNodeIds = new Set(imgNodes.map((n) => n.id));

      const boundRows12 =
        rows.length >= 2 &&
        Boolean(rows[0].imageNodeId && imgNodeIds.has(rows[0].imageNodeId)) &&
        Boolean(rows[1].imageNodeId && imgNodeIds.has(rows[1].imageNodeId)) &&
        rows[0].imageNodeId !== rows[1].imageNodeId;

      const unboundRows3to8 =
        rows.length === 8 &&
        rows.slice(2).every((r) => !r.imageNodeId && !r.videoNodeId);

      const checks = [
        {
          name: 'eight_storyboard_rows',
          passed: rows.length === 8,
          detail: `分镜行数=${rows.length}（期望 8）`,
        },
        {
          name: 'only_two_image_nodes_created',
          passed: imgNodes.length === 2,
          detail: `image 节点数=${imgNodes.length}（期望 2，不越界建 8 个）`,
        },
        {
          name: 'first_two_rows_bound_to_real_nodes',
          passed: boundRows12,
          detail: `第1镜绑定=${rows[0]?.imageNodeId || '无'}，第2镜绑定=${rows[1]?.imageNodeId || '无'}`,
        },
        {
          name: 'rows_3_to_8_remain_unbound',
          passed: unboundRows3to8,
          detail: `第3-8镜未绑定=${unboundRows3to8}`,
        },
      ];

      return {
        passed: checks.every((c) => c.passed),
        status: checks.every((c) => c.passed) ? 'passed' : 'failed',
        checks,
      };
    },
  },

  {
    id: 'local-edit',
    code: 'S3',
    aliases: ['S3', 's3', 'local-edit'],
    name: 'S3 已有画布单镜局部修改（严禁误伤其余节点）',
    description: '预置 4 镜分镜+4 首帧+4 视频画布，只改第 3 镜画面与第 3 首帧提示词，断言其余节点/行/连线零改动。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const seed = buildS3SeedCanvas(canvasId);
      const doc = simGo.ensureCanvas(canvasId, seed);
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s3-1',
        message: '只把第 3 个镜头的画面改成清晨薄雾森林，并同步更新第 3 个首帧图节点的提示词，不要动其他镜头和节点。',
      },
    ],
    evaluate({ simGo, canvasId, setupState }) {
      const before = setupState.beforeCanvas;
      const after = simGo.snapshot().canvases[canvasId];

      const beforeScript = before.nodes.find((n) => n.type === 'script');
      const afterScript = after.nodes.find((n) => n.type === 'script');
      const beforeRows = beforeScript.metadata.storyboard.rows;
      const afterRows = afterScript?.metadata?.storyboard?.rows || [];

      const forestRegex = /清晨.*薄雾.*森林|清晨薄雾森林/;
      const row3Updated =
        afterRows[2] &&
        (forestRegex.test(String(afterRows[2].plotDescription || '')) ||
          forestRegex.test(String(afterRows[2].imageGenerationPrompt || '')));

      const otherRowsUnchanged = [0, 1, 3].every(
        (idx) => JSON.stringify(beforeRows[idx]) === JSON.stringify(afterRows[idx]),
      );

      const afterImg3 = after.nodes.find((n) => n.id === 'node-img-3');
      const img3Updated =
        afterImg3 &&
        (forestRegex.test(String(afterImg3.metadata?.prompt || '')) ||
          forestRegex.test(String(afterImg3.metadata?.composerContent || '')));

      const otherNodeIds = ['node-img-1', 'node-img-2', 'node-img-4', 'node-vid-1', 'node-vid-2', 'node-vid-3', 'node-vid-4'];
      const otherNodesUnchanged = otherNodeIds.every((id) => {
        const b = before.nodes.find((n) => n.id === id);
        const a = after.nodes.find((n) => n.id === id);
        return JSON.stringify(b) === JSON.stringify(a);
      });

      const edgesUnchanged = JSON.stringify(before.connections) === JSON.stringify(after.connections);

      const checks = [
        {
          name: 'row_3_updated',
          passed: Boolean(row3Updated),
          detail: `第3镜描述=${afterRows[2]?.plotDescription || ''}`,
        },
        {
          name: 'img_3_prompt_updated',
          passed: Boolean(img3Updated),
          detail: `镜3首帧提示词=${afterImg3?.metadata?.prompt || ''}`,
        },
        {
          name: 'other_rows_unchanged',
          passed: otherRowsUnchanged,
          detail: `第1/2/4镜完全未变=${otherRowsUnchanged}`,
        },
        {
          name: 'other_nodes_unchanged',
          passed: otherNodesUnchanged && after.nodes.length === before.nodes.length,
          detail: `其余7个媒体节点完全未变=${otherNodesUnchanged}，总节点数=${after.nodes.length}`,
        },
        {
          name: 'edges_unchanged',
          passed: edgesUnchanged,
          detail: `全部12条连线未变=${edgesUnchanged}`,
        },
      ];

      return {
        passed: checks.every((c) => c.passed),
        status: checks.every((c) => c.passed) ? 'passed' : 'failed',
        checks,
      };
    },
  },

  {
    id: 'mid-turn-steer',
    code: 'S4',
    aliases: ['S4', 's4', 'mid-turn-steer'],
    name: 'S4 同轮中途补充改向（/steer 实时收敛）',
    description: '首轮发起 4 镜古风武侠需求，在模型首个请求到达时通过 /steer 注入改为赛博朋克霓虹夜市 2 镜头，同轮完成。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s4-1',
        message: '帮我规划一个 4 镜头古风武侠开场，创建脚本节点和 4 个首帧图节点。',
        steerOnFirstModelRequest: {
          message: '改成赛博朋克霓虹夜市风格，而且只需要 2 个镜头。',
        },
      },
    ],
    evaluate({ simGo, canvasId, turnRecords, steerResults }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const scriptNode = nodes.find((n) => n.type === 'script');
      const rows = scriptNode?.metadata?.storyboard?.rows || [];
      const imgNodes = nodes.filter((n) => n.type === 'image');

      const steerAccepted = steerResults.length > 0 && steerResults.every((s) => s.status === 202 && s.body?.accepted === true);
      const cyberRegex = /赛博|霓虹|夜市|全息|义体|cyberpunk|neon/i;
      const isCyberpunk =
        rows.length === 2 &&
        rows.every((r) => cyberRegex.test(`${r.plotDescription || ''} ${r.imageGenerationPrompt || ''}`)) &&
        imgNodes.every((n) => cyberRegex.test(`${n.title || ''} ${n.metadata?.prompt || ''} ${n.metadata?.composerContent || ''}`));

      const checks = [
        {
          name: 'steer_accepted_mid_turn',
          passed: steerAccepted,
          detail: `steer响应=${JSON.stringify(steerResults[0] || null)}`,
        },
        {
          name: 'converged_to_2_shots',
          passed: rows.length === 2 && imgNodes.length === 2,
          detail: `最终分镜行数=${rows.length}，image节点数=${imgNodes.length}`,
        },
        {
          name: 'style_updated_to_cyberpunk',
          passed: isCyberpunk,
          detail: `赛博朋克霓虹夜市风格生效=${isCyberpunk}`,
        },
        {
          name: 'completed_in_single_turn',
          passed: (turnRecords || []).length === 1 && !turnRecords[0]?.error,
          detail: `回合数=${(turnRecords || []).length}`,
        },
      ];

      return {
        passed: checks.every((c) => c.passed),
        status: checks.every((c) => c.passed) ? 'passed' : 'failed',
        checks,
      };
    },
  },

  {
    id: 'post-generation-review',
    code: 'S5',
    aliases: ['S5', 's5', 'post-generation-review'],
    name: 'S5 生成后自动唤醒画面复查与重提生成',
    description: '首轮提交生成提议并由模拟器完成带六指缺陷的生成产物，验证宿主是否具备 wake-on-generation 自动唤醒复查能力。',
    capabilities: ['wake-on-generation'],
    expectedBaselinePass: false,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      simGo.flagNextTaskDefect('人物右手有6根手指，手部明显畸形');
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s5-1',
        message: '创建一个特写人像首帧图节点并提交生成任务，生成完成后帮我检查画面是否有手部畸形，有问题就重写提示词重新生成。',
        confirmProposalsAfterTurn: true,
        awaitAutoWakeMs: 1000,
      },
    ],
    evaluate({ simGo, canvasId, wakeResult }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const imgNodes = (doc.nodes || []).filter((n) => n.type === 'image');
      const canvasProposals = snap.proposals.filter((p) => p.canvasId === canvasId);
      const canvasTasks = snap.tasks.filter((t) => t.canvasId === canvasId);
      const firstProposalConfirmed = canvasProposals.length >= 1 && canvasProposals[0].confirmed === true;
      const taskDelivered = canvasTasks.length >= 1 && canvasTasks[0].status === 'succeeded';
      const autoWoken = Boolean(wakeResult?.autoWoken);
      const mediaInspected = snap.counts.mediaInspections > 0;
      const reProposed = canvasProposals.length >= 2;

      const checks = [
        {
          name: 'initial_node_and_proposal_created',
          passed: imgNodes.length >= 1 && firstProposalConfirmed && taskDelivered,
          detail: `image节点=${imgNodes.length}, 首次提议已确认=${firstProposalConfirmed}, 任务已交付=${taskDelivered}`,
        },
        {
          name: 'auto_wake_on_generation',
          passed: autoWoken && mediaInspected && reProposed,
          capabilityGap: !autoWoken && wakeResult?.eventAccepted ? 'wake-on-generation' : undefined,
          detail: autoWoken
            ? `已自动唤醒并执行 media.inspect(${snap.counts.mediaInspections}) 与重提生成(${canvasProposals.length})`
            : wakeResult?.eventAccepted
              ? '完成事件已接受；观察窗口内没有自动复查 (capability gap: wake-on-generation)'
              : '生成完成事件未被宿主接受，不能据此判断自动唤醒能力',
        },
      ];

      const allPassed = checks.every((c) => c.passed);
      const hasCapabilityGap = checks.some((c) => !c.passed && c.capabilityGap);
      const onlyCapabilityGap = hasCapabilityGap && checks.every((c) => c.passed || c.capabilityGap);

      return {
        passed: allPassed,
        status: allPassed ? 'passed' : onlyCapabilityGap ? 'baseline_gap' : 'failed',
        capabilityGap: hasCapabilityGap ? 'wake-on-generation' : null,
        checks,
      };
    },
  },

  {
    id: 'skill-across-turns',
    code: 'S6',
    aliases: ['S6', 's6'],
    name: 'S6 首轮激活技能后的多轮规则保持（short-drama-storyboard）',
    description: '仅首轮选择「短剧分镜到首帧」技能，后续自然补充和确认，验证活动技能仍进入每次模型请求且首帧遵守规则；不触发或宣称压缩。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      const pin = simGo.getSkillPin('short-drama-storyboard');
      return { beforeCanvas: clone(doc), skillPin: pin };
    },
    turns: [
      {
        id: 'turn-s6-1',
        useActiveSkillPins: true,
        message:
          '[S6_TURN_1] 我选了「短剧分镜到首帧」技能。剧本梗概：雨夜天台，女记者林晚拿着染血怀表质问线人沈默（2个镜头，竖屏 9:16，写实电影感）。请先完成角色设定和分镜脚本。',
      },
      {
        id: 'turn-s6-2',
        message:
          '[S6_TURN_2] 角色设定我确认了。补充一下：林晚调查失踪案已经三年，怀表里藏着微缩胶卷，沈默其实是幕后组织联络人。请完善分镜，先让我看看。',
      },
      {
        id: 'turn-s6-3',
        message:
          '[S6_TURN_3] 天台要有积水反射远处的红色霓虹，冷蓝主光配合闪电侧逆光。先核对现有分镜是否适合这个氛围，暂时不要做图。',
      },
      {
        id: 'turn-s6-4',
        message: '[S6_TURN_4] 分镜确认了，开始准备这两个镜头的首帧吧。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords, requestEvidence = [] }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const mdNode = nodes.find((n) => (n.type === 'markdown' || n.type === 'text') && String(n.title || '').includes('角色设定'));
      const scriptNode = nodes.find((n) => n.type === 'script');
      const rows = scriptNode?.metadata?.storyboard?.rows || [];
      const imgNodes = nodes.filter((n) => n.type === 'image');

      const titlesFollowSkill =
        imgNodes.some((n) => /镜\s*1\s*首帧/.test(String(n.title || ''))) &&
        imgNodes.some((n) => /镜\s*2\s*首帧/.test(String(n.title || '')));
      const isPortrait916 = (sizeVal) => {
        const s = String(sizeVal || '').trim().toLowerCase();
        return s.includes('9:16') || ['720x1280', '1080x1920', '1024x1792', '576x1024', 'portrait'].includes(s);
      };
      const configured916 =
        imgNodes.length >= 2 &&
        imgNodes.every((n) => isPortrait916(n.metadata?.size) && Number(n.metadata?.count ?? 1) === 1);
      const rowsBound =
        rows.length === 2 &&
        rows.every((row) => imgNodes.some((node) => node.id === row.imageNodeId)) &&
        new Set(rows.map((row) => row.imageNodeId)).size === 2;
      const proposalCreated = snap.proposals.some((p) => p.canvasId === canvasId && p.kind === 'image' && p.nodeIds.length >= 2);

      const checks = [
        {
          name: 'active_skill_present_in_every_turn_request',
          passed: new Set(requestEvidence.map((entry) => entry.turnId)).size === 4 && requestEvidence.every((entry) => entry.activeSkillPresent),
          detail: `活动技能进入系统上下文=${requestEvidence.filter((entry) => entry.activeSkillPresent).length}/${requestEvidence.length} 次模型请求`,
        },
        {
          name: 'four_turns_completed_in_same_session',
          passed: (turnRecords || []).length === 4 && turnRecords.every((t) => !t.error),
          detail: `完成回合数=${(turnRecords || []).length}`,
        },
        {
          name: 'step1_and_step2_artifacts_preserved',
          passed: Boolean(mdNode) && Boolean(scriptNode) && rows.length === 2,
          detail: `角色设定节点=${Boolean(mdNode)}，分镜脚本行数=${rows.length}`,
        },
        {
          name: 'step3_image_nodes_follow_skill_naming_and_aspect',
          passed: titlesFollowSkill && configured916,
          detail: `标题符合「镜 N 首帧」=${titlesFollowSkill}，画幅9:16且count=1=${configured916} (${imgNodes.map((n) => `${n.title}:${n.metadata?.size}/${n.metadata?.count}`).join(', ')})`,
        },
        {
          name: 'step3_rows_bound_and_proposal_submitted',
          passed: rowsBound && proposalCreated,
          detail: `分镜行imageNodeId已回填=${rowsBound}，生成提议已提交=${proposalCreated}`,
        },
      ];

      return {
        passed: checks.every((c) => c.passed),
        status: checks.every((c) => c.passed) ? 'passed' : 'failed',
        checks,
      };
    },
  },
  {
    id: 'user-requested-generation-review',
    code: 'S7',
    aliases: ['S7', 's7'],
    name: 'S7 用户主动复查生成结果并修正重提',
    description: '用户确认首轮生成后，再主动要求检查产物；验证读取产物、改提示词与重提生成，重提仍等待用户确认。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      simGo.ensureCanvas(canvasId);
      simGo.flagNextTaskDefect('人物右手有6根手指，手部明显畸形');
    },
    turns: [
      {
        id: 'turn-s7-1',
        message: '创建一个特写人像首帧图节点并提交生成提议，注意手部畸形问题。',
        confirmProposalsAfterTurn: true,
      },
      {
        id: 'turn-s7-2',
        message: '图已经生成好了，请复查刚生成的画面，有问题就改提示词，再给我一个生成提议。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const proposals = snap.proposals.filter((proposal) => proposal.canvasId === canvasId);
      const tasks = snap.tasks.filter((task) => task.canvasId === canvasId);
      const nodes = snap.canvases[canvasId]?.nodes || [];
      const reviewOps = snap.opLog.filter((operation) => operation.turnId === turnRecords[1]?.turnId && operation.status === 'ok');
      const inspectedAt = reviewOps.findIndex((operation) => operation.op === 'media.inspect');
      const correctedAt = reviewOps.findIndex((operation) => operation.op === 'canvas.node.update');
      const proposedAt = reviewOps.findIndex((operation) => operation.op === 'canvas.generation.propose');
      const checks = [
        {
          name: 'explicit_user_review_after_delivery',
          passed: turnRecords.length === 2 && turnRecords.every((turn) => !turn.error) && tasks.length === 1 && tasks[0].status === 'succeeded',
          detail: `用户轮次=${turnRecords.length}，首次生成任务已交付=${tasks[0]?.status === 'succeeded'}`,
        },
        {
          name: 'result_inspected_and_prompt_corrected',
          passed: inspectedAt >= 0 && correctedAt > inspectedAt && proposedAt > correctedAt && nodes.length === 1,
          detail: `按顺序检查、修改、重提=${inspectedAt >= 0 && correctedAt > inspectedAt && proposedAt > correctedAt}，在原节点修改而非重复创建=${nodes.length === 1}`,
        },
        {
          name: 'replacement_proposal_waits_for_user_confirmation',
          passed: proposals.length === 2 && proposals[0].confirmed && !proposals[1].confirmed && tasks.length === 1,
          detail: `提议数=${proposals.length}，重提尚未确认=${proposals[1]?.confirmed === false}，实际任务数=${tasks.length}`,
        },
      ];
      return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
    },
  },
];

export function resolveScenarioList(selector = 'all') {
  const norm = String(selector || 'all').trim();
  if (!norm || norm.toLowerCase() === 'all') return SCENARIOS;
  const parts = norm.split(',').map((s) => s.trim()).filter(Boolean);
  const matched = [];
  for (const part of parts) {
    const found = SCENARIOS.find(
      (s) => s.id.toLowerCase() === part.toLowerCase() || s.code.toLowerCase() === part.toLowerCase() || (s.aliases || []).some((a) => a.toLowerCase() === part.toLowerCase()),
    );
    if (!found) {
      throw new Error(`未知评测场景: ${part}（可选: all, ${SCENARIOS.map((s) => `${s.code}/${s.id}`).join(', ')}）`);
    }
    if (!matched.includes(found)) matched.push(found);
  }
  return matched;
}
