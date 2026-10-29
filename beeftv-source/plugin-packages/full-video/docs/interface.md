# 接口合同

创建 `POST /v1/videos`；查询 `GET /v1/videos/{id}`；原片下载 `GET /v1/videos/{id}/download`。凭据仅发往用户配置的 API 地址。

本地参考素材通过 `/v1/media/uploads` 分片上传，完成后核对内容摘要、字节数、类型及真实时长。默认仅接受同域素材；独立素材域名须由用户在连接设置中明确填写。

不同服务的同名模型不保证协议一致，请按服务商接口文档选择此协议。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "full-video",
  "name": "全参视频",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "全参 2.0 / 2.5 的 JSON 请求、素材上传和原片下载。",
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
        "id": "full-video",
        "label": "全参视频",
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
            "description": "全参模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "mapping": "prompt",
            "description": "创作提示词。"
          },
          {
            "name": "duration",
            "type": "integer",
            "mapping": "seconds",
            "description": "整数秒数。"
          },
          {
            "name": "resolution",
            "type": "string",
            "mapping": "resolution",
            "description": "画质。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "mapping": "aspect_ratio",
            "description": "画幅。"
          },
          {
            "name": "images",
            "type": "media[]",
            "mapping": "references",
            "description": "参考图片。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "mapping": "references",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "mapping": "references",
            "description": "参考音频。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$in": [
                {
                  "$ref": "request.model"
                },
                [
                  "sd-native-full-2.0",
                  "sd-native-full-2.5",
                  "原生不卡人脸-全参2.0",
                  "原生不卡人脸-全参2.5"
                ]
              ]
            },
            "message": "此协议支持全参 2.0 / 2.5，请选择对应模型。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/videos",
          "contentType": "application/json",
          "headers": {
            "Idempotency-Key": {
              "$ref": "request.extra.idempotencyKey"
            }
          },
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "seconds": {
              "$ref": "request.duration"
            },
            "resolution": {
              "$ref": "request.resolution"
            },
            "aspect_ratio": {
              "$ref": "request.aspectRatio"
            },
            "references": {
              "$omitEmpty": {
                "$concatArrays": [
                  {
                    "$map": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "in": {
                        "type": "image",
                        "source": {
                          "$ref": "media.value"
                        },
                        "role": "reference"
                      }
                    }
                  },
                  {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "type": "video",
                        "source": {
                          "$ref": "media.value"
                        },
                        "role": "reference",
                        "duration_seconds": {
                          "$divide": [
                            {
                              "$ref": "media.metadata.durationMs"
                            },
                            1000
                          ]
                        }
                      }
                    }
                  },
                  {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
                      },
                      "as": "media",
                      "in": {
                        "type": "audio",
                        "source": {
                          "$ref": "media.value"
                        },
                        "role": "reference",
                        "duration_seconds": {
                          "$divide": [
                            {
                              "$ref": "media.metadata.durationMs"
                            },
                            1000
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}"
        },
        "result": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}/download",
          "headers": {
            "Accept": "video/mp4"
          }
        },
        "response": {
          "taskIdPaths": [
            "id"
          ],
          "statusPaths": [
            "status"
          ],
          "messagePaths": [
            "error.message",
            "message"
          ],
          "errorPaths": [
            "error.code"
          ],
          "resultKind": "video",
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
