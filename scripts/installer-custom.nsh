; 豆包工作站 3.0：安装时解压 agent-host 的 node_modules。
; electron-builder 在 extraResources 与 NSIS 两处都会忽略 node_modules 目录名，
; 因此依赖以 agent-host-node_modules.zip 随包携带，这里还原到 agent-host/node_modules。
!macro customInstall
  IfFileExists "$INSTDIR\resources\agent-host-node_modules.zip" 0 skip_agent_nm
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command Expand-Archive -LiteralPath "$INSTDIR\resources\agent-host-node_modules.zip" -DestinationPath "$INSTDIR\resources\agent-host" -Force'
    Delete "$INSTDIR\resources\agent-host-node_modules.zip"
  skip_agent_nm:
!macroend
