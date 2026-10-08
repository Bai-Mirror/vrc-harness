; Harness installer hooks (bundle > windows > nsis > installerHooks in tauri.windows.conf.json).
;
; The generated installer.nsi is rebuilt from the Tauri template on every build and is not ours to edit, so the two
; defects it leaves behind are repaired from the hooks the template exposes. Both were measured on this machine
; (lane L15, section 4) and both are about the one registry value the installer keeps between runs:
; HKCU\Software\avatar-harness\Harness, whose default value is the last install location.
;
;   1. PREINSTALL. .onInit fills $INSTDIR with the default $LOCALAPPDATA\Harness and then calls
;      RestorePreviousInstallLocation, which overwrites it with that remembered value. A remembered path that has
;      since been deleted, cannot be written, or sits in a temporary directory (a dry run install leaves exactly
;      that behind) installs a whole fresh copy into a dead tree: no Start-menu entry a user would find, no
;      uninstaller a user could reach, and no error. Such a location now falls back to the default.
;   2. POSTUNINSTALL. The template deletes the key only inside its "delete app data" branch, and a silent uninstall
;      never creates the checkbox that selects that branch. The location memory therefore outlived every silent
;      uninstall and pointed at a directory that no longer existed, which is what steered the next install.
;
; ENCODING: the message printed for an interactive install is Simplified Chinese, so this file must stay UTF-8 *with
; a byte order mark*. makensis reads a source file without a BOM as the system ANSI codepage and stops with "Bad
; text encoding" on the first non-ASCII byte; test/package/installer-hooks.test.ts guards the BOM.

; True in $R0 when $INSTDIR is the given root itself or lies under it, otherwise 0.
;
; StrCmp ignores case, which is what comparing Windows paths needs. A trailing separator on the root — what
; GetTempPath() returns — is dropped first. A sibling whose name merely begins with the same letters is not a match:
; the character following the root has to be a separator or the end of the string, so C:\Temp never claims
; C:\Temporary\Harness. Uses $R0-$R2 and $R9, which the template never touches.
; Root in on the stack, nothing out.
Function HarnessPathIsUnderRoot
  Exch $R9
  Push $R1
  Push $R2
  StrCpy $R0 0
  StrCpy $R1 "$R9" 1 -1
  ${If} $R1 == "\"
    StrCpy $R9 "$R9" -1
  ${EndIf}
  StrLen $R1 "$R9"
  ${If} $R1 > 0
    StrCpy $R2 "$INSTDIR" $R1
    ${If} $R2 == "$R9"
      StrCpy $R2 "$INSTDIR" 1 $R1
      ${If} $R2 == ""
      ${OrIf} $R2 == "\"
        StrCpy $R0 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R9
FunctionEnd

; Sets $R7 to "temp" when $INSTDIR is inside the given temporary directory. Skipped once a reason is already known.
; NSIS has $TEMP and no $TMP: $TEMP is GetTempPath(), which is built from the TMP and TEMP environment variables,
; so all three are checked, plus the per-user temp directory Windows always has.
!macro HarnessRejectIfUnderTemp ROOT
  ${If} $R7 == ""
    Push "${ROOT}"
    Call HarnessPathIsUnderRoot
    ${If} $R0 = 1
      StrCpy $R7 "temp"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; --- keep the remembered install location only while it is still usable ---
  StrCpy $R9 "$LOCALAPPDATA\${PRODUCTNAME}"
  ReadRegStr $R8 SHCTX "${MANUPRODUCTKEY}" ""
  ; Only a location the template restored needs checking, and only when it is not already the default. The
  ; comparison against the registry value is what tells a restored location from a directory the user named
  ; explicitly with /D= or on the directory page: those are accepted as chosen.
  ${If} $R8 != ""
  ${AndIf} $R8 == $INSTDIR
  ${AndIf} $INSTDIR != $R9
    StrCpy $R7 ""
    ; (a) a temporary directory is never an install location
    !insertmacro HarnessRejectIfUnderTemp "$TEMP"
    ReadEnvStr $R5 "TMP"
    !insertmacro HarnessRejectIfUnderTemp "$R5"
    ReadEnvStr $R5 "TEMP"
    !insertmacro HarnessRejectIfUnderTemp "$R5"
    !insertmacro HarnessRejectIfUnderTemp "$LOCALAPPDATA\Temp"
    ; (b) it has to be writable, or the install stops part way through and leaves a half-written tree behind
    ${If} $R7 == ""
      ClearErrors
      FileOpen $R6 "$INSTDIR\harness-install-write-probe.tmp" w
      ${If} ${Errors}
        StrCpy $R7 "unwritable"
      ${Else}
        FileClose $R6
        Delete "$INSTDIR\harness-install-write-probe.tmp"
      ${EndIf}
    ${EndIf}
    ; (c) and it has to still hold a Harness installation, because a location the user deleted cannot be seen as
    ;     absent from here: the template's own `SetOutPath $INSTDIR` runs just above and recreates it empty. That was
    ;     measured rather than assumed — a remembered path under %TEMP% that did not exist reported "temp" and never
    ;     "missing", because the existence test written here first could not fail. So the question is what is inside
    ;     the directory, and one the template recreated holds neither the binary nor the previous version's uninstaller.
    ${If} $R7 == ""
      ${IfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ${AndIfNot} ${FileExists} "$INSTDIR\uninstall.exe"
        StrCpy $R7 "missing"
      ${EndIf}
    ${EndIf}
    ; The order matters and is tested: every rule leaves the ones after it reachable. A directory already refused for
    ; being temporary is never probed for an installation, and a rule that fired first for the wrong reason would make
    ; the next one dead code — which is exactly how the existence test above was found to do nothing.
    ${If} $R7 != ""
      DetailPrint "Harness：上次的安装位置 $INSTDIR 已不可用（$R7），本次安装到 $R9。"
      WriteRegStr SHCTX "${MANUPRODUCTKEY}" "RejectedInstallLocation" "$INSTDIR"
      WriteRegStr SHCTX "${MANUPRODUCTKEY}" "RejectedInstallLocationReason" "$R7"
      StrCpy $INSTDIR "$R9"
      SetOutPath "$INSTDIR"
    ${Else}
      DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "RejectedInstallLocation"
      DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "RejectedInstallLocationReason"
    ${EndIf}
  ${EndIf}

  ; --- an upgrade installs over the previous version ---
  ; The GUI's files are named after their content hashes: every earlier version's would stay behind, and
  ; uninstalling (which removes what the current version installed) would leave them too. Only a folder that
  ; already holds the Harness app is touched, and in it only the GUI's own directory.
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    RMDir /r "$INSTDIR\dist\gui-app"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; --- forget the remembered install location, whichever way the user asked to uninstall ---
  ; The template's own DeleteRegKey sits in its $DeleteAppDataCheckboxState = 1 branch, which a silent uninstall
  ; never reaches, so this repeats that cleanup for every real uninstall: the install location, the language the
  ; installer remembered, and the rejected-location note above all go, and the vendor key goes with them once it is
  ; empty. Removing the program is not removing the user's data — $APPDATA\${BUNDLEID} and $LOCALAPPDATA\${BUNDLEID}
  ; are deliberately left to the template's checkbox.
  ;
  ; $UpdateMode = 1 means a newer installer started this uninstaller as part of an upgrade, and the template
  ; deliberately preserves the remembered location across updates: that installer records its own location right
  ; after this returns.
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
!macroend
