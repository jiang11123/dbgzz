# 接口说明

## 选择条件

服务商文档须同时符合以下格式：Bearer 鉴权；`POST /v1/video/generations`；JSON；`images` 支持带 `url` 和 `role` 的对象数组；时长用整数 `duration`，比例用 `ratio`。不能仅凭模型名或“OpenAI 兼容”判断。

例如 [WhatsToken 视频接口](https://www.whatstoken.ai/docs/openai/doc0007)及 [Seedance 示例](https://www.whatstoken.ai/docs/examples/doc0047)公开了此格式。服务地址和 API Key 由用户填写，不内置域名识别。

## 输入与图片角色

`model`、`prompt`、`duration`、`ratio`、`resolution`、`generate_audio`、`watermark` 按原值发送。图片按用户顺序发送，保留 `first_frame`、`last_frame` 或 `reference_image`；没有角色时明确发送 `reference_image`，避免两张参考图被上游推断成首尾帧。`videos`、`audios` 为素材地址数组。具体数量、尺寸、时长和可用功能以模型合同及用户配置为准。

## 查询、响应与错误

创建响应应含 `task_id` 或 `id`。查询为 `GET /v1/video/generations/{task_id}`；成功响应使用 `status: completed` 和 `data: [{url: "https://..."}]`。失败状态和 `error.code` 按失败处理，`error.message` 保留说明；HTTP 错误不包装成成功。结果链接是临时素材，由宿主取回保存。

本插件不声明取消或鉴权内容下载端点，也不会在失败后切换其他协议重发。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "video-generations-json",
  "name": "视频生成 JSON · ratio / duration",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "使用 images、ratio、duration 的异步视频 JSON 协议。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "video-generations-json",
        "label": "视频生成 JSON · ratio / duration",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "服务商提供的准确模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "mapping": "images",
            "description": "保留顺序与 role 的图片对象数组。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "mapping": "videos",
            "description": "参考视频链接数组。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "mapping": "audios",
            "description": "参考音频链接数组。"
          },
          {
            "name": "duration",
            "type": "integer",
            "mapping": "duration",
            "description": "时长，单位为秒。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "mapping": "ratio",
            "description": "画幅比例。"
          },
          {
            "name": "resolution",
            "type": "string",
            "mapping": "resolution",
            "description": "分辨率。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "mapping": "generate_audio",
            "description": "声音开关。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "mapping": "watermark",
            "description": "水印开关。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/video/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "images": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "url": {
                      "$ref": "media.value"
                    },
                    "role": {
                      "$coalesce": [
                        {
                          "$ref": "media.role"
                        },
                        "reference_image"
                      ]
                    }
                  }
                }
              }
            },
            "videos": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.videos"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "audios": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.audios"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "duration": {
              "$ref": "request.duration"
            },
            "ratio": {
              "$ref": "request.aspectRatio"
            },
            "resolution": {
              "$omitEmpty": {
                "$ref": "request.resolution"
              }
            },
            "generate_audio": {
              "$ref": "request.generateAudio"
            },
            "watermark": {
              "$ref": "request.watermark"
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/video/generations/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "item",
              "in": {
                "$ref": "item.url"
              }
            }
          },
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
