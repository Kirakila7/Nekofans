# -*- coding: utf-8 -*-
Unicode true
RequestExecutionLevel user
ManifestLongPathAware true
SetCompressor /SOLID lzma
SetDatablockOptimize on
Name "${NEKO_DISPLAY_NAME}"
OutFile "${NEKO_OUTPUT}"
InstallDir "${NEKO_INSTALL_ROOT}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NEKO_APP_ID}" "InstallLocation"
VIProductVersion "${NEKO_NUMERIC_VERSION}"
VIAddVersionKey "ProductName" "${NEKO_DISPLAY_NAME}"
VIAddVersionKey "FileDescription" "Nekofans 当前用户安装程序"
VIAddVersionKey "FileVersion" "${NEKO_VERSION}"
VIAddVersionKey "LegalCopyright" "NEKOfuns contributors"
!include "MUI2.nsh"
!ifdef NEKO_ICON
!define MUI_ICON "${NEKO_ICON}"
!define MUI_UNICON "${NEKO_ICON}"
!endif
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!define NEKO_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NEKO_APP_ID}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\NEKOfuns.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 Nekofans"
!define MUI_FINISHPAGE_TEXT "安装完成。账号存档和项目保留在原有位置。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 Nekofans 的安装位置。可使用默认目录，也可点击“浏览”选择其它磁盘上的空文件夹。"
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var ManagedLog
Var BusyProcess
Var SafePath
Var OwnProcessId

; PROCESSENTRY32W is 556 bytes in the standard x86 Unicode NSIS runtime,
; including the ULONG_PTR field. QueryFullProcessImageNameW reads paths of
; both x86 and x64 children. No process is terminated by this installer.
!macro ProcessGuard Prefix
Function ${Prefix}CheckSafePath
  Exch $0
  Push $1
  Push $2
  StrCpy $SafePath 1
  safe_path_loop:
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
    ${If} $1 != -1
      IntOp $1 $1 & 0x400
      ${If} $1 != 0
        StrCpy $SafePath 0
        Goto safe_path_done
      ${EndIf}
    ${EndIf}
    ${GetParent} "$0" $2
    ${If} $2 == ""
    ${OrIf} $2 == $0
      Goto safe_path_done
    ${EndIf}
    StrCpy $0 $2
    Goto safe_path_loop
  safe_path_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${Prefix}FindRunningApplication
  StrCpy $BusyProcess ""
  System::Call 'kernel32::GetCurrentProcessId() i.r3'
  StrCpy $OwnProcessId $3
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r0'
  ${If} $0 == -1
    StrCpy $BusyProcess "无法检查运行中的程序"
    Return
  ${EndIf}
  System::Alloc 556
  Pop $1
  ${If} $1 == 0
    System::Call 'kernel32::CloseHandle(p r0)'
    StrCpy $BusyProcess "无法检查运行中的程序"
    Return
  ${EndIf}
  System::Call '*$1(i 556)'
  System::Call 'kernel32::Process32FirstW(p r0, p r1) i.r2'
  ${If} $2 == 0
    StrCpy $BusyProcess "无法检查运行中的程序"
    Goto process_done
  ${EndIf}
  process_loop:
    ${If} $2 == 0
      Goto process_done
    ${EndIf}
    IntOp $R0 $1 + 8
    System::Call '*$R0(i .r3)'
    ${If} $3 == $OwnProcessId
      Goto process_next
    ${EndIf}
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r3) p.r4'
    ${If} $4 != 0
      StrCpy $6 ${NSIS_MAX_STRLEN}
      System::Call 'kernel32::QueryFullProcessImageNameW(p r4, i 0, w .r5, *i r6) i.r7'
      System::Call 'kernel32::CloseHandle(p r4)'
      ${If} $7 != 0
        StrLen $8 "$INSTDIR\"
        StrCpy $9 $5 $8
        ${If} $9 == "$INSTDIR\"
          StrCpy $BusyProcess $5
          Goto process_done
        ${EndIf}
      ${EndIf}
    ${EndIf}
    process_next:
    System::Call 'kernel32::Process32NextW(p r0, p r1) i.r2'
    Goto process_loop
  process_done:
  System::Free $1
  System::Call 'kernel32::CloseHandle(p r0)'
FunctionEnd

Function ${Prefix}RequireClosedApplication
  process_check:
    Call ${Prefix}FindRunningApplication
    ${If} $BusyProcess != ""
      IfSilent process_silent
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请先关闭当前安装目录中的 Nekofans 和工作任务，再点击重试。不会强制结束任务。$\r$\n$\r$\n$BusyProcess" /SD IDCANCEL IDRETRY process_check
      SetErrorLevel 1602
      Quit
      process_silent:
      SetErrorLevel 1618
      Quit
    ${EndIf}
FunctionEnd
!macroend
!insertmacro ProcessGuard ""
!insertmacro ProcessGuard "un."

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Nekofans 需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 1633
    Quit
  ${EndIf}
FunctionEnd

Function ValidateInstallDirectory
  StrCpy $SafePath 1
  ; The NSIS instruction requires an existing parent and can erase $INSTDIR
  ; on a fresh installation. The Win32 API canonicalizes missing paths too.
  StrCpy $0 $INSTDIR
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    Goto unsafe_target
  ${EndIf}
  StrCpy $INSTDIR $1
  Push "$INSTDIR"
  Call CheckSafePath
  ${If} $SafePath != 1
    Goto unsafe_target
  ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == "$0\"
    Goto unsafe_target
  ${EndIf}
  ${If} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$APPDATA"
  ${OrIf} $INSTDIR == "$DOCUMENTS"
  ${OrIf} $INSTDIR == "$WINDIR"
    Goto unsafe_target
  ${EndIf}
  IfFileExists "$INSTDIR\.nekofuns-install-id" target_owned
  FindFirst $0 $1 "$INSTDIR\*"
  target_contents:
    ${If} $1 == ""
      FindClose $0
      Goto target_ready
    ${EndIf}
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      Goto unsafe_target
    ${EndIf}
    FindNext $0 $1
    Goto target_contents
  target_owned:
    Push "$INSTDIR\.nekofuns-install-id"
    Call CheckSafePath
    ${If} $SafePath != 1
      Goto unsafe_target
    ${EndIf}
    Push "$INSTDIR\.nekofuns-managed-files"
    Call CheckSafePath
    ${If} $SafePath != 1
      Goto unsafe_target
    ${EndIf}
    ClearErrors
    FileOpen $0 "$INSTDIR\.nekofuns-install-id" r
    IfErrors unsafe_target
    FileRead $0 $1
    FileClose $0
    ${If} $1 != "${NEKO_APP_ID}"
      Goto unsafe_target
    ${EndIf}
  target_ready:
    StrCpy $SafePath 1
    Return
  unsafe_target:
    StrCpy $SafePath 0
FunctionEnd

Function DirectoryPageLeave
  Call ValidateInstallDirectory
  ${If} $SafePath != 1
    MessageBox MB_OK|MB_ICONSTOP "目标目录无效、包含其它文件或不属于此安装程序。请选择空目录或原 Nekofans 安装位置。" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "NEKOfuns"
  ; Validate the final selection again, including silent /D= installations.
  Call ValidateInstallDirectory
  ${If} $SafePath != 1
    MessageBox MB_OK|MB_ICONSTOP "目标目录无效、包含其它文件或不属于此安装程序，未覆盖。" /SD IDOK
    SetErrorLevel 1603
    Quit
  ${EndIf}
  Call RequireClosedApplication
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors install_failed
  FileOpen $0 "$INSTDIR\.nekofuns-install-id" w
  IfErrors install_failed
  FileWrite $0 "${NEKO_APP_ID}"
  IfErrors install_failed
  FileClose $0
  FileOpen $ManagedLog "$INSTDIR\.nekofuns-managed-files" a
  IfErrors install_failed
  ; NSIS "a" preserves bytes but still starts its pointer at zero.
  FileSeek $ManagedLog 0 END
  IfErrors install_failed
  SetOverwrite on
  !include "${NEKO_FILES_INCLUDE}"
  FileClose $ManagedLog
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors install_failed
  CreateDirectory "$SMPROGRAMS\${NEKO_GROUP}"
  CreateShortcut "$SMPROGRAMS\${NEKO_GROUP}\NEKOfuns.lnk" "$INSTDIR\NEKOfuns.exe"
  CreateShortcut "$SMPROGRAMS\${NEKO_GROUP}\卸载 NEKOfuns.lnk" "$INSTDIR\Uninstall.exe"
  !ifdef NEKO_DESKTOP_SHORTCUT
    CreateShortcut "$DESKTOP\NEKOfuns.lnk" "$INSTDIR\NEKOfuns.exe"
  !endif
  WriteRegStr HKCU "${NEKO_REG_KEY}" "DisplayName" "${NEKO_DISPLAY_NAME}"
  WriteRegStr HKCU "${NEKO_REG_KEY}" "DisplayVersion" "${NEKO_VERSION}"
  WriteRegStr HKCU "${NEKO_REG_KEY}" "Publisher" "NEKOfuns contributors"
  WriteRegStr HKCU "${NEKO_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${NEKO_REG_KEY}" "DisplayIcon" "$INSTDIR\NEKOfuns.exe"
  WriteRegStr HKCU "${NEKO_REG_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${NEKO_REG_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${NEKO_REG_KEY}" "EstimatedSize" ${NEKO_ESTIMATED_KB}
  WriteRegDWORD HKCU "${NEKO_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${NEKO_REG_KEY}" "NoRepair" 1
  Goto install_done
  install_failed:
    FileClose $ManagedLog
    MessageBox MB_OK|MB_ICONSTOP "安装文件未能完整写入，请关闭使用这些文件的程序后重新运行安装。账号和项目数据未删除。" /SD IDOK
    SetErrorLevel 1603
    Abort
  install_done:
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ReadRegStr $0 HKCU "${NEKO_REG_KEY}" "InstallLocation"
  ${If} $0 != $INSTDIR
    Goto invalid_uninstall
  ${EndIf}
  Push "$INSTDIR\.nekofuns-install-id"
  Call un.CheckSafePath
  ${If} $SafePath != 1
    Goto invalid_uninstall
  ${EndIf}
  Push "$INSTDIR\.nekofuns-managed-files"
  Call un.CheckSafePath
  ${If} $SafePath != 1
    Goto invalid_uninstall
  ${EndIf}
  FileOpen $0 "$INSTDIR\.nekofuns-install-id" r
  IfErrors invalid_uninstall
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${NEKO_APP_ID}"
    Goto invalid_uninstall
  ${EndIf}
  Call un.RequireClosedApplication
  Return
  invalid_uninstall:
    MessageBox MB_OK|MB_ICONSTOP "没有找到匹配的 NEKOfuns 安装标记，未删除文件。" /SD IDOK
    SetErrorLevel 1603
    Quit
FunctionEnd

Section "Uninstall"
  ClearErrors
  FileOpen $ManagedLog "$INSTDIR\.nekofuns-managed-files" r
  IfErrors uninstall_failed
  managed_loop:
    ClearErrors
    FileReadUTF16LE $ManagedLog $0
    IfErrors managed_done
    trim_newline:
      StrCpy $1 $0 1 -1
      ${If} $1 == "$\r"
      ${OrIf} $1 == "$\n"
        StrCpy $0 $0 -1
        Goto trim_newline
      ${EndIf}
    ${If} $0 == ""
      Goto managed_loop
    ${EndIf}
    ; Log entries are data, never commands or wildcard delete expressions.
    StrCpy $2 0
    validate_character:
      StrCpy $1 $0 1 $2
      ${If} $1 == ""
        Goto validate_path
      ${EndIf}
      ${If} $1 == "*"
      ${OrIf} $1 == "?"
      ${OrIf} $1 == ":"
      ${OrIf} $1 == '$\"'
        Goto managed_loop
      ${EndIf}
      IntOp $2 $2 + 1
      Goto validate_character
    validate_path:
      GetFullPathName $3 "$INSTDIR\$0"
      StrLen $4 "$INSTDIR\"
      StrCpy $5 $3 $4
      ${If} $5 != "$INSTDIR\"
        Goto managed_loop
      ${EndIf}
      Push "$3"
      Call un.CheckSafePath
      ${If} $SafePath != 1
        Goto uninstall_failed
      ${EndIf}
      IfFileExists "$3" 0 managed_loop
      ClearErrors
      Delete "$3"
      IfErrors uninstall_failed
      ${GetParent} "$3" $6
      remove_empty_parent:
        ${If} $6 == "$INSTDIR"
          Goto managed_loop
        ${EndIf}
        RMDir "$6"
        ${GetParent} "$6" $6
        Goto remove_empty_parent
  managed_done:
  FileClose $ManagedLog
  Delete "$INSTDIR\.nekofuns-managed-files"
  Delete "$INSTDIR\.nekofuns-install-id"
  Delete "$SMPROGRAMS\${NEKO_GROUP}\NEKOfuns.lnk"
  Delete "$SMPROGRAMS\${NEKO_GROUP}\卸载 NEKOfuns.lnk"
  RMDir "$SMPROGRAMS\${NEKO_GROUP}"
  !ifdef NEKO_DESKTOP_SHORTCUT
    Delete "$DESKTOP\NEKOfuns.lnk"
  !endif
  DeleteRegKey HKCU "${NEKO_REG_KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto uninstall_done
  uninstall_failed:
    FileClose $ManagedLog
    MessageBox MB_OK|MB_ICONSTOP "部分程序文件正在使用或无法删除。请关闭工作台后重试；账号和项目数据保持原样。" /SD IDOK
    SetErrorLevel 1603
    Abort
  uninstall_done:
SectionEnd
