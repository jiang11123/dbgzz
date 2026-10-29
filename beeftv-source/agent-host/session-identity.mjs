// 会话动作身份：把「哪一个会话 + 哪一次工具调用」映射成一个稳定的 operationId 前缀。
//
// 身份必须绑定在单个会话上，不能用宿主进程级变量：同一进程里 A、B 两个画布会各建一条
// 会话，全局变量会让后建的会话覆盖前一个的身份，使 A 的写入带上 B 的前缀（同一
// toolCallId 在两条会话里也可能撞成同一个 operationId）。
//
// Durable 会话用官方持久会话 id（`durable:<uuid>`）作为前缀：进程重启后同一会话的
// 未确认动作仍映射到同一 operationId，不会因为换了一次 RUN_ID 而被重复执行。

export function toolOperationId(prefix, toolCallId, fallback) {
  const identity = String(prefix || '').trim();
  const call = String(toolCallId || '').trim() || String(fallback || '').trim();
  return `${identity}:${call}`;
}
