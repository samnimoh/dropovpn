!macro customInstall
  DetailPrint "Installing the included OpenVPN engine and signed network driver..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\openvpn\install-openvpn.ps1"'
  Pop $0
  ${If} $0 == 3010
  ${OrIf} $0 == 1641
    SetRebootFlag true
    IfSilent +2
      MessageBox MB_OK|MB_ICONINFORMATION "DropoVPN and OpenVPN are installed. Restart Windows before connecting."
  ${ElseIf} $0 != 0
    SetErrorLevel 1
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "OpenVPN setup could not finish. DropoVPN cannot connect until its engine and driver are installed. Close other installers and run this setup again. Details are in %TEMP%\DropoVPN-OpenVPN-setup.log."
    Abort "OpenVPN setup failed. Run the DropoVPN installer again to repair it."
  ${EndIf}
!macroend

; OpenVPN and its driver are shared system components. Removing DropoVPN
; deliberately leaves them installed for other VPN clients. The user can
; remove OpenVPN separately through Windows Installed Apps when no longer used.
