Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "TextFunc.nsh"
!include "FileFunc.nsh"
${StrStr}
${UnStrStr}
Name "BeefTV"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\Programs\BeefTV"
# Upgrades default to the previous location; the user can still choose another folder.
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "InstallLocation"
Var BackupDir
Var CleanDir
Var InstallParent
Var PreviousInstallDir
Var RegisteredInstallDir
Var InstallerMutex
Var InstallLog
Var InstallPhase
Var LogLine
Var MoveFrom
Var MoveTo
Var MoveError
Var MoveAttempt
Var OldMoved
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "BeefTV"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "BeefTV Setup"
VIAddVersionKey "LegalCopyright" "BeefTV"
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\BeefTV.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString BEEFTV_DIR_FOREIGN ${LANG_ENGLISH} "This folder already holds other files and is not a BeefTV installation. Choose an empty folder or the current BeefTV location."
LangString BEEFTV_DIR_FOREIGN ${LANG_SIMPCHINESE} "这个文件夹里已有其他文件，不是 BeefTV 安装位置。请选择一个空文件夹，或当前的 BeefTV 安装位置。"
LangString BEEFTV_DIR_WRITE ${LANG_ENGLISH} "BeefTV cannot write here. Administrator rights are required, so choose another folder."
LangString BEEFTV_DIR_WRITE ${LANG_SIMPCHINESE} "需要管理员权限，请选择其他文件夹。"
LangString BEEFTV_BUSY ${LANG_ENGLISH} "Another BeefTV installer or uninstaller is running. Close it and try again."
LangString BEEFTV_BUSY ${LANG_SIMPCHINESE} "另一个 BeefTV 安装或卸载程序正在运行。请先关闭它，再试一次。"
LangString BEEFTV_CLOSE ${LANG_ENGLISH} "Please close BeefTV and its CLI, then choose Retry."
LangString BEEFTV_CLOSE ${LANG_SIMPCHINESE} "请退出 BeefTV 及其命令行程序，然后点击“重试”。"
LangString BEEFTV_RETRY ${LANG_ENGLISH} "Windows could not move this application folder (error $MoveError):$\r$\n$MoveFrom$\r$\n$\r$\nClose programs or terminal windows using it, then choose Retry. Cancel stops this installation.$\r$\nLog: $InstallLog"
LangString BEEFTV_RETRY ${LANG_SIMPCHINESE} "Windows 无法移动以下程序文件夹（错误 $MoveError）：$\r$\n$MoveFrom$\r$\n$\r$\n请关闭正在使用它的程序或终端窗口，然后点击“重试”。点击“取消”将停止安装。$\r$\n安装日志：$InstallLog"
LangString BEEFTV_PRESERVED ${LANG_ENGLISH} "Installation stopped. The previous application is still at $INSTDIR. Your projects are preserved.$\r$\nLog: $InstallLog"
LangString BEEFTV_PRESERVED ${LANG_SIMPCHINESE} "安装已停止，原程序仍保留在 $INSTDIR，项目不会被删除。$\r$\n安装日志：$InstallLog"
LangString BEEFTV_STOPPED ${LANG_ENGLISH} "Installation stopped. Your projects are preserved.$\r$\nLog: $InstallLog"
LangString BEEFTV_STOPPED ${LANG_SIMPCHINESE} "安装已停止，项目不会被删除。$\r$\n安装日志：$InstallLog"
LangString BEEFTV_RESTORE_FAILED ${LANG_ENGLISH} "Windows could not restore the previous application. It is preserved at:$\r$\n$BackupDir$\r$\nDo not delete this folder. Contact support with this log:$\r$\n$InstallLog"
LangString BEEFTV_RESTORE_FAILED ${LANG_SIMPCHINESE} "Windows 未能恢复原程序，原文件保留在：$\r$\n$BackupDir$\r$\n请不要删除此文件夹，并将安装日志发给客服：$\r$\n$InstallLog"

# Keep the handle until process exit. Installation and uninstallation must not
# race while moving folders or updating the per-user registration.
!macro InstallerLock PREFIX
Function ${PREFIX}AcquireInstallerLock
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\BeefTV.Installation") p .r0 ?e'
  Pop $1
  StrCpy $InstallerMutex $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(BEEFTV_BUSY)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
!macroend
!insertmacro InstallerLock ""
!insertmacro InstallerLock "un."

Function WriteInstallLog
  Push $0
  FileOpen $0 "$InstallLog" a
  FileSeek $0 0 END
  FileWrite $0 "$InstallPhase: $LogLine$\r$\n"
  FileClose $0
  Pop $0
FunctionEnd

# MoveFileW exposes the actual Windows error; NSIS Rename only exposes a flag.
# Brief file scanner/shutdown locks get a bounded automatic retry.
Function MoveInstallFolder
  move_retry:
  StrCpy $MoveAttempt 0
  move_attempt:
  System::Call 'kernel32::MoveFileW(w "$MoveFrom", w "$MoveTo") i .r0 ?e'
  Pop $MoveError
  ${If} $0 != 0
    StrCpy $LogLine 'moved "$MoveFrom" -> "$MoveTo"'
    Call WriteInstallLog
    Return
  ${EndIf}
  StrCpy $LogLine 'error=$MoveError moving "$MoveFrom" -> "$MoveTo"'
  Call WriteInstallLog
  IntOp $MoveAttempt $MoveAttempt + 1
  ${If} $MoveAttempt < 20
    ${If} $MoveError == 5
    ${OrIf} $MoveError == 32
    ${OrIf} $MoveError == 33
      Sleep 500
      Goto move_attempt
    ${EndIf}
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(BEEFTV_RETRY)" /SD IDCANCEL IDRETRY move_retry
  StrCpy $0 0
FunctionEnd

# Appends a dedicated BeefTV subfolder to the chosen location (including drive
# roots like D:\ or E:\), then validates that final folder. Choosing E:\ or
# D:\Apps therefore installs to E:\BeefTV or D:\Apps\BeefTV and never mixes the
# payload with the user's other files. Sets $0 to 0 when valid, or 2 (foreign
# folder), 3 (not writable).
Function PrepareInstallDir
  StrCpy $0 0
  ${If} $INSTDIR == ""
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\BeefTV"
  ${EndIf}
  # Drop trailing separators so the last component is a real name.
  StrCpy $1 "$INSTDIR"
  PrepareInstallDir_trim:
    StrCpy $2 "$1" 1 -1
    ${If} $2 == "\"
    ${OrIf} $2 == "/"
      StrCpy $3 "$1" -1
      ${If} $3 != ""
        StrCpy $1 "$3"
        Goto PrepareInstallDir_trim
      ${EndIf}
    ${EndIf}
  ${GetRoot} "$1" $2
  ${If} $2 == "$1"
    StrCpy $1 "$1\BeefTV"
  ${Else}
    ${GetFileName} "$1" $2
    ${If} $2 != "BeefTV"
      StrCpy $1 "$1\BeefTV"
    ${EndIf}
  ${EndIf}
  # An existing final folder is only reused when it is a previous BeefTV
  # install (or portable BeefTV directory) or empty.
  StrCpy $5 ""
  ${If} ${FileExists} "$1\*.*"
    ${IfNot} ${FileExists} "$1\.installed-root-files.txt"
    ${AndIfNot} ${FileExists} "$1\BeefTV.exe"
      StrCpy $3 ""
      FindFirst $2 $4 "$1\*"
      PrepareInstallDir_scan:
        ${If} $4 != ""
        ${AndIf} $4 != "."
        ${AndIf} $4 != ".."
          StrCpy $3 "1"
        ${EndIf}
        ${If} $4 != ""
          FindNext $2 $4
          Goto PrepareInstallDir_scan
        ${EndIf}
      FindClose $2
      ${If} $3 != ""
        StrCpy $0 2
        Return
      ${EndIf}
    ${EndIf}
  ${ElseIf} ${FileExists} "$1"
    StrCpy $0 2
    Return
  ${Else}
    StrCpy $5 "created"
  ${EndIf}
  # The installer runs as the current user, so Program Files and other
  # administrator-only folders must be rejected before anything is written.
  ClearErrors
  CreateDirectory "$1"
  FileOpen $2 "$1\.beeftv-write-test" w
  ${If} ${Errors}
    StrCpy $0 3
  ${Else}
    FileClose $2
    Delete "$1\.beeftv-write-test"
  ${EndIf}
  # Leave no empty folder behind if the user goes back and picks another one.
  ${If} $5 == "created"
    RMDir "$1"
  ${EndIf}
  ${If} $0 == 0
    StrCpy $INSTDIR "$1"
  ${EndIf}
FunctionEnd

Function ShowInstallDirError
  ${If} $0 == 2
    MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_DIR_FOREIGN)" /SD IDOK
  ${ElseIf} $0 == 3
    MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_DIR_WRITE)" /SD IDOK
  ${EndIf}
FunctionEnd

Function DirectoryPageLeave
  Call PrepareInstallDir
  ${If} $0 != 0
    Call ShowInstallDirError
    Abort
  ${EndIf}
FunctionEnd

!macro RequireClosed PREFIX
Function ${PREFIX}RequireClosed
  retry_closed_${PREFIX}:
  StrCpy $3 0
  check_closed_${PREFIX}:
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq BeefTV.exe" /NH'
  Pop $0
  Pop $1
!if "${PREFIX}" == "un."
  ${UnStrStr} $2 $1 "BeefTV.exe"
!else
  ${StrStr} $2 $1 "BeefTV.exe"
!endif
  ${If} $2 == ""
!if "${PREFIX}" == "un."
    ${UnStrStr} $2 $1 "beeftv.exe"
!else
    ${StrStr} $2 $1 "beeftv.exe"
!endif
  ${EndIf}
  ${If} $0 == 0
  ${AndIf} $2 == ""
    ${If} $3 > 0
      # Allow child WebView2 / runtime processes a brief moment to release handles.
      Sleep 500
    ${EndIf}
    Return
  ${EndIf}
  IntOp $3 $3 + 1
  ${If} $3 == 1
    # Ask BeefTV's main window to close cleanly first so SQLite and WebView2
    # flush state before exiting.
    nsExec::Exec '"$SYSDIR\taskkill.exe" /IM BeefTV.exe'
    Pop $0
    Sleep 500
    Goto check_closed_${PREFIX}
  ${ElseIf} $3 <= 10
    Sleep 500
    Goto check_closed_${PREFIX}
  ${ElseIf} $3 == 11
    # Force-terminate any remaining BeefTV or CLI process tree.
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM BeefTV.exe /T'
    Pop $0
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM beeftv.exe /T'
    Pop $0
    Sleep 500
    Goto check_closed_${PREFIX}
  ${ElseIf} $3 <= 20
    Sleep 500
    Goto check_closed_${PREFIX}
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(BEEFTV_CLOSE)" /SD IDCANCEL IDRETRY retry_closed_${PREFIX}
  SetErrorLevel 2
  Abort
FunctionEnd
!macroend
!insertmacro RequireClosed ""
!insertmacro RequireClosed "un."

# Clean only shipped root files and runtime directories. Unknown user files remain.
!macro RemovePayload PREFIX
Function ${PREFIX}RemovePayload
  FileOpen $0 "$CleanDir\.installed-root-files.txt" r
  ${If} $0 != ""
    loop_${PREFIX}:
      ClearErrors
      FileRead $0 $1
      IfErrors done_${PREFIX}
      ${TrimNewLines} $1 $1
!if "${PREFIX}" == "un."
      ${UnStrStr} $2 $1 "\"
      ${UnStrStr} $3 $1 "/"
      ${UnStrStr} $4 $1 ":"
      ${UnStrStr} $5 $1 ".."
!else
      ${StrStr} $2 $1 "\"
      ${StrStr} $3 $1 "/"
      ${StrStr} $4 $1 ":"
      ${StrStr} $5 $1 ".."
!endif
      ${If} $1 != ""
      ${AndIf} $2 == ""
      ${AndIf} $3 == ""
      ${AndIf} $4 == ""
      ${AndIf} $5 == ""
        Delete "$CleanDir\$1"
      ${EndIf}
      Goto loop_${PREFIX}
    done_${PREFIX}:
    FileClose $0
  ${EndIf}
  Delete "$CleanDir\BeefTV.exe"
  Delete "$CleanDir\.installed-root-files.txt"
  Delete "$CleanDir\Uninstall.exe"
  RMDir /r "$CleanDir\agent-host"
  RMDir /r "$CleanDir\plugin-packages"
  RMDir /r "$CleanDir\cli"
  RMDir /r "$CleanDir\media-runtime"
  RMDir "$CleanDir"
FunctionEnd
!macroend
!insertmacro RemovePayload ""
!insertmacro RemovePayload "un."

Function .onInit
  SetShellVarContext current
  Call AcquireInstallerLock
  ClearErrors
  CreateDirectory "$LOCALAPPDATA\BeefTV\Installer"
  GetTempFileName $InstallLog "$LOCALAPPDATA\BeefTV\Installer"
  ${If} ${Errors}
    ClearErrors
    GetTempFileName $InstallLog "$TEMP"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_DIR_WRITE)" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  Delete "$InstallLog"
  StrCpy $InstallLog "$InstallLog.log"
  StrCpy $InstallPhase "startup"
  StrCpy $LogLine 'version=${VERSION} destination="$INSTDIR"'
  Call WriteInstallLog
  ReadRegStr $PreviousInstallDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "InstallLocation"
  Call RequireClosed
  # Interactive runs validate on the directory page; /D= needs the same checks here.
  ${If} ${Silent}
    Call PrepareInstallDir
    ${If} $0 != 0
      Call ShowInstallDirError
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  Call un.AcquireInstallerLock
  Call un.RequireClosed
FunctionEnd

Function .onInstFailed
  StrCpy $LogLine "installation failed or was cancelled"
  Call WriteInstallLog
FunctionEnd

Section "BeefTV (required)" SEC_APP
  SectionIn RO
  Call RequireClosed
  StrCpy $InstallPhase "prepare"
  ${GetParent} "$INSTDIR" $InstallParent
  StrCpy $0 "$InstallParent" 1 -1
  ${If} $0 != "\"
    StrCpy $InstallParent "$InstallParent\"
  ${EndIf}
  ${IfNot} ${FileExists} "$InstallParent*.*"
    ClearErrors
    CreateDirectory "$InstallParent"
    IfErrors prepare_failed
  ${EndIf}
  SetOutPath "$InstallParent"
  StrCpy $OldMoved 0
  StrCpy $BackupDir ""
  IfFileExists "$INSTDIR\*.*" 0 install_new
  ClearErrors
  GetTempFileName $BackupDir "$InstallParent"
  IfErrors prepare_failed
  Delete "$BackupDir"
  IfErrors prepare_failed
  Goto backup_existing
  prepare_failed:
  StrCpy $LogLine 'could not prepare installation beside "$INSTDIR"'
  Call WriteInstallLog
  MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_STOPPED)" /SD IDOK
  SetErrorLevel 1
  Abort
  backup_existing:
  StrCpy $InstallPhase "backup"
  StrCpy $MoveFrom "$INSTDIR"
  StrCpy $MoveTo "$BackupDir"
  Call MoveInstallFolder
  ${If} $0 == 0
    Goto install_failed
  ${EndIf}
  StrCpy $OldMoved 1
  install_new:
  # Extract directly into $INSTDIR so newly written executables never require a
  # post-extraction directory rename while antivirus scanners hold read handles.
  StrCpy $InstallPhase "extract"
  StrCpy $LogLine 'backup="$BackupDir" destination="$INSTDIR"'
  Call WriteInstallLog
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors extract_failed
  File /r "${PAYLOAD}\*"
  File /oname=.installed-root-files.txt "${ROOTFILES}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    extract_failed:
    StrCpy $LogLine 'payload extraction or uninstaller write failed in "$INSTDIR"'
    Call WriteInstallLog
    SetOutPath "$InstallParent"
    StrCpy $CleanDir "$INSTDIR"
    Call RemovePayload
    RMDir /r "$INSTDIR"
    Goto install_restore
  ${EndIf}
  StrCpy $InstallPhase "activate"
  StrCpy $LogLine 'moved "$BackupDir" -> "$INSTDIR"'
  Call WriteInstallLog
  ${If} $OldMoved == 1
    SetOutPath "$InstallParent"
    StrCpy $CleanDir "$BackupDir"
    Call RemovePayload
    ${If} ${FileExists} "$BackupDir\*.*"
      FindFirst $2 $4 "$BackupDir\*"
      preserve_user_files:
        ${If} $4 == ""
          Goto preserve_user_files_done
        ${EndIf}
        ${If} $4 != "."
        ${AndIf} $4 != ".."
          ${IfNot} ${FileExists} "$INSTDIR\$4"
            Rename "$BackupDir\$4" "$INSTDIR\$4"
          ${EndIf}
        ${EndIf}
        FindNext $2 $4
        Goto preserve_user_files
      preserve_user_files_done:
      FindClose $2
      RMDir "$BackupDir"
    ${EndIf}
  ${EndIf}
  Goto install_registered
  install_restore:
  ${If} $OldMoved == 1
    StrCpy $InstallPhase "restore"
    StrCpy $MoveFrom "$BackupDir"
    StrCpy $MoveTo "$INSTDIR"
    Call MoveInstallFolder
    ${If} $0 == 0
      # Preserve BOTH trees when rollback is blocked; never delete the only
      # working old application or obscure its exact recovery location.
      MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_RESTORE_FAILED)" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  install_failed:
  ${If} ${FileExists} "$INSTDIR\*.*"
    MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_PRESERVED)" /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "$(BEEFTV_STOPPED)" /SD IDOK
  ${EndIf}
  SetErrorLevel 1
  Abort
  install_registered:
  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\BeefTV"
  CreateShortcut "$SMPROGRAMS\BeefTV\BeefTV.lnk" "$INSTDIR\BeefTV.exe"
  CreateShortcut "$SMPROGRAMS\BeefTV\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\BeefTV.lnk" "$INSTDIR\BeefTV.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayName" "BeefTV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayIcon" "$INSTDIR\BeefTV.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "NoRepair" 1
  WriteRegStr HKCU "Software\Classes\beeftv" "" "URL:BeefTV skill link"
  WriteRegStr HKCU "Software\Classes\beeftv" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\beeftv\shell\open\command" "" '$\"$INSTDIR\BeefTV.exe$\" $\"%1$\"'
  # A successful move replaces the registered install; remove only the old
  # installer's shipped payload. Unknown user files remain in that directory.
  ${If} $PreviousInstallDir != ""
  ${AndIf} $PreviousInstallDir != $INSTDIR
  ${AndIf} ${FileExists} "$PreviousInstallDir\.installed-root-files.txt"
    StrCpy $CleanDir "$PreviousInstallDir"
    Call RemovePayload
  ${EndIf}
  SetOutPath "$INSTDIR"
  StrCpy $InstallPhase "registered"
  StrCpy $LogLine 'installed="$INSTDIR"'
  Call WriteInstallLog
SectionEnd

Section "Uninstall"
  # NSIS sets $INSTDIR to the uninstaller's folder. Keep the working directory
  # out of it so the empty install folder can be removed.
  ${GetParent} "$INSTDIR" $0
  StrCpy $1 "$0" 1 -1
  ${If} $1 != "\"
    StrCpy $0 "$0\"
  ${EndIf}
  SetOutPath "$0"
  StrCpy $CleanDir "$INSTDIR"
  Call un.RemovePayload
  # A stale uninstaller copied from an older location must not unregister
  # or remove shortcuts for the current installation.
  ReadRegStr $RegisteredInstallDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "InstallLocation"
  ${If} $RegisteredInstallDir == $INSTDIR
    ReadRegStr $0 HKCU "Software\Classes\beeftv\shell\open\command" ""
    ${If} $0 == '$\"$INSTDIR\BeefTV.exe$\" $\"%1$\"'
      DeleteRegKey HKCU "Software\Classes\beeftv"
    ${EndIf}
    Delete "$DESKTOP\BeefTV.lnk"
    Delete "$SMPROGRAMS\BeefTV\BeefTV.lnk"
    Delete "$SMPROGRAMS\BeefTV\Uninstall.lnk"
    RMDir "$SMPROGRAMS\BeefTV"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV"
  ${EndIf}
SectionEnd
