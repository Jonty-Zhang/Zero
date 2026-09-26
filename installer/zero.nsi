Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck on
XPStyle on

!ifndef STAGE_DIR
  !error "STAGE_DIR must point at a verified Windows release stage"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be set"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.0"
!endif

!include "MUI2.nsh"

Name "Zero"
Caption "Zero Setup"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Zero"
ShowInstDetails show
ShowUninstDetails show
BrandingText "Zero"

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Zero"
VIAddVersionKey /LANG=1033 "FileDescription" "Zero Windows installer"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Zero contributors"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "Zero was installed"
!define MUI_FINISHPAGE_TEXT "Zero was installed for this Windows account.$\r$\n$\r$\nTo start Zero, open Start Menu > Zero > Start Zero. Keep the PowerShell window open while you use Zero; close it or press Ctrl+C to stop Zero. Zero does not start automatically when Windows starts.$\r$\n$\r$\nRuntime data will be stored in $LOCALAPPDATA\Zero and is retained when Zero is uninstalled."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  ; /D= is a supported NSIS override. Keep this installer constrained to its
  ; documented per-user program directory so rollback cannot target arbitrary paths.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Zero"
  ; An existing marker or any entry in the destination means this is an upgrade
  ; or a user-owned directory. This first version deliberately refuses both.
  ReadRegStr $0 HKCU "Software\Zero\Installer" "InstallDir"
  StrCmp $0 "" 0 init_refuse
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero" "InstallLocation"
  StrCmp $0 "" 0 init_refuse
  IfFileExists "$SMPROGRAMS\Zero\." init_refuse
  IfFileExists "$INSTDIR\." 0 init_check_task
  FindFirst $R0 $R1 "$INSTDIR\*"
  find_loop:
    StrCmp $R1 "" find_done
    StrCmp $R1 "." find_next
    StrCmp $R1 ".." find_next
    FindClose $R0
    Goto init_refuse
  find_next:
    FindNext $R0 $R1
    Goto find_loop
  find_done:
  FindClose $R0
  init_check_task:
  ; Refuse a legacy installation even if it was placed outside the default path.
  nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /query /tn "Zero Task Node"'
  Pop $0
  Pop $1
  StrCmp $0 "0" init_refuse
  StrCmp $0 "1" init_guardian_check
  Goto init_refuse
  init_guardian_check:
  ; A guardian may have been launched outside Task Scheduler. Refuse whenever
  ; any guardian process exists; uninstall cannot safely replace a live image.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name guardian -ErrorAction SilentlyContinue) { exit 10 } else { exit 0 }"'
  Pop $0
  Pop $1
  StrCmp $0 "0" init_done
  Goto init_refuse
  init_refuse:
    MessageBox MB_ICONSTOP|MB_OK "A Zero installation directory or Zero Task Node already exists. This installer only supports first installation and will not overwrite it. Uninstall the existing version first." /SD IDOK
    Abort
  init_done:
FunctionEnd

Function .onInstFailed
  ; Preflight proved the fixed destination was absent or empty. Remove only
  ; this installer-owned program directory and shortcut; runtime data is separate.
  SetShellVarContext current
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\Zero\Zero Dashboard.url"
  Delete "$SMPROGRAMS\Zero\Start Zero.lnk"
  Delete "$SMPROGRAMS\Zero\Uninstall Zero.lnk"
  RMDir "$SMPROGRAMS\Zero"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero"
  DeleteRegKey HKCU "Software\Zero\Installer"
FunctionEnd

Section "Install Zero" SEC_MAIN
  SetShellVarContext current
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors install_failed
  File /r "${STAGE_DIR}\*"
  IfErrors install_failed

  ; The installer carries the already verified manifest for support/auditing.
  IfFileExists "$INSTDIR\manifest.json" 0 install_failed
  ClearErrors
  CreateDirectory "$SMPROGRAMS\Zero"
  WriteINIStr "$SMPROGRAMS\Zero\Zero Dashboard.url" "InternetShortcut" "URL" "http://127.0.0.1:4179"
  CreateShortcut "$SMPROGRAMS\Zero\Start Zero.lnk" \
    "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" \
    '-NoProfile -ExecutionPolicy RemoteSigned -File "$INSTDIR\scripts\start-zero.ps1"' \
    "$INSTDIR\guardian\guardian.exe" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\Zero\Uninstall Zero.lnk" "$INSTDIR\uninstall.exe"
  IfErrors install_failed

  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall.exe"
  IfErrors install_failed
  WriteRegStr HKCU "Software\Zero\Installer" "InstallDir" "$INSTDIR"
  IfErrors install_failed
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero" "DisplayName" "Zero"
  IfErrors install_failed
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero" "DisplayVersion" "${PRODUCT_VERSION}"
  IfErrors install_failed
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero" "InstallLocation" "$INSTDIR"
  IfErrors install_failed
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero" "UninstallString" '"$INSTDIR\uninstall.exe"'
  IfErrors install_failed
  Goto install_done
  install_failed:
    RMDir /r "$INSTDIR"
    Delete "$SMPROGRAMS\Zero\Zero Dashboard.url"
    Delete "$SMPROGRAMS\Zero\Start Zero.lnk"
    Delete "$SMPROGRAMS\Zero\Uninstall Zero.lnk"
    RMDir "$SMPROGRAMS\Zero"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero"
    DeleteRegKey HKCU "Software\Zero\Installer"
    SetErrorLevel 1
    Abort "Zero installation failed. The installer will remove its partial program files. Runtime data was not touched."
  install_done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; The user explicitly chose uninstall. Ask the existing credential-free
  ; helper to stop and unregister the task before deleting its executable.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\scripts\uninstall-windows-task.ps1" -Unattended'
  Pop $0
  Pop $1
  StrCmp $0 "0" uninstall_task_removed
  MessageBox MB_ICONSTOP|MB_OK "Could not remove the Zero scheduled task. The program files were kept. Review Task Scheduler and try uninstall again." /SD IDOK
  Abort
  uninstall_task_removed:
  Delete "$SMPROGRAMS\Zero\Zero Dashboard.url"
  Delete "$SMPROGRAMS\Zero\Start Zero.lnk"
  Delete "$SMPROGRAMS\Zero\Uninstall Zero.lnk"
  RMDir "$SMPROGRAMS\Zero"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Zero"
  DeleteRegKey HKCU "Software\Zero\Installer"
  RMDir /r "$INSTDIR"
  ; Deliberately retain $LOCALAPPDATA\Zero, which stores runtime state.
SectionEnd
