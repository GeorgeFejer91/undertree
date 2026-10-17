Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "wrAIter for Word"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\wrAIter Word"
InstallDirRegKey HKCU "Software\wrAIterWord" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${PAYLOAD}\wrAIter.ico"
!define MUI_UNICON "${PAYLOAD}\wrAIter.ico"
VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "wrAIter for Word"
VIAddVersionKey "FileDescription" "wrAIter for Microsoft Word installer"
VIAddVersionKey "FileVersion" "0.1.0"
VIAddVersionKey "LegalCopyright" "UnderTree contributors"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro Register VIEW
SetRegView ${VIEW}
WriteRegStr HKCU "Software\Classes\UnderTree.WordAddin" "" "wrAIter for Word"
WriteRegStr HKCU "Software\Classes\UnderTree.WordAddin\CLSID" "" "{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}" "" "wrAIter for Word"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\ProgId" "" "UnderTree.WordAddin"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "" "mscoree.dll"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "ThreadingModel" "Both"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "Class" "UnderTree.WordAddin.ComAddin"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "Assembly" "wrAIter.Word, Version=0.1.0.0, Culture=neutral, PublicKeyToken=null"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "RuntimeVersion" "v4.0.30319"
WriteRegStr HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}\InprocServer32" "CodeBase" "file:///$INSTDIR\wrAIter.Word.dll"
WriteRegStr HKCU "Software\Microsoft\Office\Word\Addins\UnderTree.WordAddin" "FriendlyName" "wrAIter for Word"
WriteRegStr HKCU "Software\Microsoft\Office\Word\Addins\UnderTree.WordAddin" "Description" "Selective AI editing with local passage permissions and bundled MCP connection"
WriteRegDWORD HKCU "Software\Microsoft\Office\Word\Addins\UnderTree.WordAddin" "LoadBehavior" 3
!macroend

Function .onInit
FindWindow $0 "OpusApp"
${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Save your documents and close Word before installing wrAIter." /SD IDOK
    Abort
${EndIf}
SetRegView 64
ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE" ""
${If} $0 == ""
    SetRegView 32
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE" ""
${EndIf}
${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Install desktop Microsoft Word before installing wrAIter." /SD IDOK
    Abort
${EndIf}
SetRegView 64
ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
${If} $0 < 528040
    MessageBox MB_OK|MB_ICONEXCLAMATION "wrAIter requires Windows 10/11 with .NET Framework 4.8. Install that Windows component before continuing." /SD IDOK
    Abort
${EndIf}
FunctionEnd

Section "wrAIter for Word"
SetOutPath "$INSTDIR"
File "${PAYLOAD}\wrAIter.Word.dll"
File "${PAYLOAD}\README.md"
File "${PAYLOAD}\THIRD-PARTY.md"
File "${PAYLOAD}\zrok-LICENSE"
File "${PAYLOAD}\build-manifest.json"
File "${PAYLOAD}\wrAIter.ico"
SetOutPath "$INSTDIR\runtime"
File "${PAYLOAD}\runtime\zrok.exe"
!insertmacro Register 64
!insertmacro Register 32
SetRegView 64
WriteRegStr HKCU "Software\wrAIterWord" "InstallDir" "$INSTDIR"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "DisplayName" "wrAIter for Word"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "DisplayVersion" "0.1.0"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "Publisher" "UnderTree contributors"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "InstallLocation" "$INSTDIR"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "DisplayIcon" "$INSTDIR\wrAIter.ico"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "NoModify" 1
WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord" "NoRepair" 1
WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
FindWindow $0 "OpusApp"
${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Save your documents and close Word before uninstalling wrAIter." /SD IDOK
    Abort
${EndIf}
SetRegView 64
DeleteRegKey HKCU "Software\Microsoft\Office\Word\Addins\UnderTree.WordAddin"
DeleteRegKey HKCU "Software\Classes\UnderTree.WordAddin"
DeleteRegKey HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}"
DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\wrAIterWord"
DeleteRegKey HKCU "Software\wrAIterWord"
SetRegView 32
DeleteRegKey HKCU "Software\Microsoft\Office\Word\Addins\UnderTree.WordAddin"
DeleteRegKey HKCU "Software\Classes\UnderTree.WordAddin"
DeleteRegKey HKCU "Software\Classes\CLSID\{12E46C89-0A1D-4E2E-AECB-2C51D78F1907}"
Delete "$INSTDIR\wrAIter.Word.dll"
Delete "$INSTDIR\README.md"
Delete "$INSTDIR\THIRD-PARTY.md"
Delete "$INSTDIR\zrok-LICENSE"
Delete "$INSTDIR\build-manifest.json"
Delete "$INSTDIR\wrAIter.ico"
Delete "$INSTDIR\runtime\zrok.exe"
RMDir "$INSTDIR\runtime"
Delete "$INSTDIR\Uninstall.exe"
RMDir "$INSTDIR"
SectionEnd
