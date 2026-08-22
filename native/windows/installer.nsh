!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\undertree.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "call $\"$INSTDIR\undertree.cmd$\" %*$\r$\n"
  FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\undertree.cmd"
!macroend
