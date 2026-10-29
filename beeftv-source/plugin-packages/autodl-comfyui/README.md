# AutoDL ComfyUI 视频与音频

该插件把BeefTV统一媒体请求转换为 AutoDL.Art ComfyUI 工作流参数。视频图片先按 `media.role` 区分首帧、尾帧和普通参考图，再按 `media.order` 生成工作流要求的 `ref_image_N`；数字后缀只表示上游工作流槽位，不再承担首尾帧语义。新增 `minimax_h3_zm_u24` 与 `minimax_h3_zm_u08` 多参考工作流，`@图片1` 会映射为 `ref_image_0`。

本插件由 BeefTV Contributors 维护，用于适配 AutoDL.Art 相关服务接口；不表示 BeefTV 与该服务商存在隶属、授权或合作关系。

完整接口、工作流分支和字段规则见 [docs/interface.md](docs/interface.md)。
