export function persistedTaskConstraintCopy(message: string) {
    for (const input of ["video_first_frame_ratio_unreadable", "video_first_frame_ratio_unsupported", "video_first_frame_ratio_mismatch", "视频画幅仅支持 当前传入 adaptive", "TaskTypeConstraint ratio first-frame", "TaskTypeConstraint duration", "TaskTypeConstraint ratio", "TaskTypeConstraint"]) {
        const copy = taskConstraintCopy(input)!;
        if (message.trim().startsWith(`${copy.reason}。${copy.action}`)) return copy;
    }
    return undefined;
}

export function taskConstraintCopy(message: string) {
    const text = message.toLowerCase();
    if (text.includes("video_first_frame_ratio_unreadable")) return { reason: "无法读取首帧图片的尺寸", action: "请重新上传 PNG、JPEG 或 WebP 图片后再生成" };
    if (text.includes("video_first_frame_ratio_unsupported")) return { reason: "当前渠道无法保持这张首帧图的比例", action: "请将首帧调整为 1:1、4:3、3:4、9:16、16:9 或 21:9，或更换模型" };
    if (text.includes("video_first_frame_ratio_mismatch")) return { reason: "输出比例需要与首帧一致", action: "请使用随首帧比例，或先调整首帧图片的尺寸" };
    if (text.includes("视频画幅仅支持") && text.includes("当前传入 adaptive")) return { reason: "当前渠道暂不支持自适应画幅", action: "首帧生成请更换模型；文生视频请指定固定比例后再提交" };
    if (!text.includes("tasktypeconstraint")) return undefined;
    if (text.includes("ratio") && /first[-_]frame/.test(text)) return { reason: "首尾帧模式的画面比例需跟随首帧", action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式" };
    if (text.includes("duration")) return { reason: "当前任务模式不支持指定的视频时长", action: "编辑视频时请使用跟随原视频的时长；如需生成指定时长，请改用参考生成模式" };
    if (text.includes("ratio")) return { reason: "当前任务模式的画面比例需跟随输入素材", action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式" };
    return { reason: "生成参数与当前任务模式不兼容", action: "请检查所选模式；首尾帧和延长需跟随素材比例，编辑还需跟随原视频时长" };
}
